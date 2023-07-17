import { v4 } from 'uuid';
import {
  type Chunker,
  fromBuffer,
  fromDataSource,
  isAppIdProviderCheck,
  streamToBuffer,
} from '../utils/index.js';
import { base64 } from '../../../src/encodings/index.js';
import { TDF } from '../tdf.js';
import { OIDCRefreshTokenProvider } from '../../../src/auth/oidc-refreshtoken-provider.js';
import { OIDCExternalJwtProvider } from '../../../src/auth/oidc-externaljwt-provider.js';
import { PemKeyPair } from '../crypto/declarations.js';
import { AppIdAuthProvider, AuthProvider, HttpRequest } from '../../../src/auth/auth.js';
import EAS from '../../../src/auth/Eas.js';
import {
  DecryptParams,
  DecryptParamsBuilder,
  type DecryptSource,
  DEFAULT_SEGMENT_SIZE,
  EncryptParams,
  EncryptParamsBuilder,
  type Scope,
} from './builders.js';
import { DecoratedReadableStream } from './DecoratedReadableStream.js';
import { Policy } from '../models/index.js';
import { cryptoToPemPair, generateKeyPair, rsaPkcs1Sha256 } from '../crypto/index.js';
import { TdfError } from '../errors.js';

const GLOBAL_BYTE_LIMIT = 64 * 1000 * 1000 * 1000; // 64 GB, see WS-9363.
const HTML_BYTE_LIMIT = 100 * 1000 * 1000; // 100 MB, see WS-9476.

// No default config for now. Delegate to Virtru wrapper for endpoints.
const defaultClientConfig = { oidcOrigin: '' };

const makeChunkable = async (source: DecryptSource) => {
  if (!source) {
    throw new Error('Invalid source');
  }
  // we don't support streams anyway (see zipreader.js)
  let initialChunker: Chunker;
  let buf = null;
  if (source.type === 'stream') {
    buf = await streamToBuffer(source.location);
    initialChunker = fromBuffer(buf);
  } else {
    initialChunker = await fromDataSource(source);
  }
  // Pull first two bytes from source.
  return initialChunker;
};

export interface ClientConfig {
  // WARNING please do not use this except for testing purposes.
  keypair?: PemKeyPair;
  organizationName?: string;
  clientId?: string;
  dpopEnabled?: boolean;
  kasEndpoint?: string;
  easEndpoint?: string;
  // DEPRECATED Ignored
  keyRewrapEndpoint?: string;
  // DEPRECATED Ignored
  keyUpsertEndpoint?: string;
  clientSecret?: string;
  refreshToken?: string;
  kasPublicKey?: string;
  oidcOrigin?: string;
  externalJwt?: string;
  authProvider?: AuthProvider | AppIdAuthProvider;
  readerUrl?: string;
  entityObjectEndpoint?: string;
  fileStreamServiceWorker?: string;
  progressHandler?: (bytesProcessed: number) => void;
}

/*
 * Extract a keypair provided as part of the options.
 * Default to using the clientwide keypair, generating one if necessary.
 *
 * Additionally, update the auth injector with the (potentially new) pubkey
 */
export async function createSessionKeys({
  authProvider,
  dpopEnabled,
  keypair,
}: {
  authProvider?: AuthProvider | AppIdAuthProvider;
  dpopEnabled?: boolean;
  keypair?: PemKeyPair;
}): Promise<SessionKeys> {
  //If clientconfig has keypair, assume auth provider was already set up with pubkey and bail
  const k2 = keypair || (await cryptoToPemPair(await generateKeyPair()));
  let signingKeys;

  if (dpopEnabled) {
    signingKeys = await crypto.subtle.generateKey(rsaPkcs1Sha256(), true, ['sign']);
  }

  // This will contact the auth server and forcibly refresh the auth token claims,
  // binding the token and the (new) pubkey together.
  // Note that we base64 encode the PEM string here as a quick workaround, simply because
  // a formatted raw PEM string isn't a valid header value and sending it raw makes keycloak's
  // header parser barf. There are more subtle ways to solve this, but this works for now.
  if (authProvider && !isAppIdProviderCheck(authProvider)) {
    await authProvider?.updateClientPublicKey(base64.encode(k2.publicKey), signingKeys);
  }
  return { keypair: k2, signingKeys };
}

/*
 * If we have KAS url but not public key we can fetch it from KAS
 */
export async function fetchKasPubKey(kasEndpoint: string): Promise<string> {
  if (!kasEndpoint) {
    throw new TdfError('KAS definition not found');
  }
  try {
    return await TDF.getPublicKeyFromKeyAccessServer(kasEndpoint);
  } catch (e) {
    throw new TdfError(`Retrieving KAS public key [${kasEndpoint}] failed [${e}]`);
  }
}

export type SessionKeys = {
  keypair: PemKeyPair;
  signingKeys?: CryptoKeyPair;
};

export class Client {
  /**
   * Default kas endpoint, if present. Required for encrypt.
   */
  readonly kasEndpoint: string;

  readonly kasPublicKey: Promise<string>;

  readonly clientId?: string;

  readonly authProvider?: AuthProvider | AppIdAuthProvider;

  readonly readerUrl?: string;

  /**
   * Session keys.
   */
  readonly sessionKeys: Promise<SessionKeys>;

  readonly eas?: EAS;

  readonly dpopEnabled: boolean;

  readonly clientConfig: ClientConfig;

  /**
   * An abstraction for protecting and accessing data using TDF3 services.
   * @param {Object} [config.keypair] - keypair generated for signing. Optional, will be generated by sdk if not passed
   * @param {String} [config.clientId]
   * @param {String} [config.kasEndpoint] - Key Access Server url
   * @param {String} [config.clientSecret] - Should be added ONLY for Node build
   * @param {String} [config.refreshToken] - After logging in to browser OIDC interface user
   * receives fresh token that needed by SDK for auth needs
   * @param {String} [config.externalJwt] - JWT from external authority (eg Google)
   * @param {String} [config.oidcOrigin] - Endpoint of authentication service
   */
  constructor(config: ClientConfig) {
    const clientConfig = { ...defaultClientConfig, ...config };
    this.dpopEnabled = !!clientConfig.dpopEnabled;

    clientConfig.readerUrl && (this.readerUrl = clientConfig.readerUrl);

    if (clientConfig.kasEndpoint) {
      this.kasEndpoint = clientConfig.kasEndpoint;
    } else {
      // handle Deprecated `kasRewrapEndpoint` parameter
      if (!clientConfig.keyRewrapEndpoint) {
        throw new Error('KAS definition not found');
      }
      this.kasEndpoint = clientConfig.keyRewrapEndpoint.replace(/\/rewrap$/, '');
    }

    this.authProvider = config.authProvider;
    this.clientConfig = clientConfig;

    if (this.authProvider && isAppIdProviderCheck(this.authProvider)) {
      this.eas = new EAS({
        authProvider: this.authProvider,
        endpoint:
          clientConfig.entityObjectEndpoint || `${clientConfig.easEndpoint}/api/entityobject`,
      });
    }

    this.clientId = clientConfig.clientId;
    if (!this.authProvider) {
      if (!clientConfig.clientId) {
        throw new Error('Client ID or custom AuthProvider must be defined');
      }

      //If you're in a browser and passing client secrets, you're Doing It Wrong.
      if (clientConfig.clientSecret) {
        throw new Error('Client credentials not supported in a browser context');
      }
      //Are we exchanging a refreshToken for a bearer token (normal AuthCode browser auth flow)?
      //If this is a browser context, we expect the caller to handle the initial
      //browser-based OIDC login and authentication process against the OIDC endpoint using their chosen method,
      //and provide us with a valid refresh token/clientId obtained from that process.
      if (clientConfig.refreshToken) {
        this.authProvider = new OIDCRefreshTokenProvider({
          clientId: clientConfig.clientId,
          refreshToken: clientConfig.refreshToken,
          oidcOrigin: clientConfig.oidcOrigin,
        });
      } else if (clientConfig.externalJwt) {
        //Are we exchanging a JWT previously issued by a trusted external entity (e.g. Google) for a bearer token?
        this.authProvider = new OIDCExternalJwtProvider({
          clientId: clientConfig.clientId,
          externalJwt: clientConfig.externalJwt,
          oidcOrigin: clientConfig.oidcOrigin,
        });
      }
    }
    if (clientConfig.keypair) {
      this.sessionKeys = Promise.resolve({ keypair: clientConfig.keypair });
    } else {
      this.sessionKeys = createSessionKeys({
        authProvider: this.authProvider,
        dpopEnabled: this.dpopEnabled,
        keypair: clientConfig.keypair,
      });
    }
    if (clientConfig.kasPublicKey) {
      this.kasPublicKey = Promise.resolve(clientConfig.kasPublicKey);
    } else {
      this.kasPublicKey = fetchKasPubKey(this.kasEndpoint);
    }
  }

  /**
   * Encrypt plaintext into TDF ciphertext. One of the core operations of the Virtru SDK.
   *
   * @param scope dissem and attributes for constructing the policy
   * @param source nodeJS source object of unencrypted data
   * @param [asHtml] If we should wrap the TDF data in a self-opening HTML wrapper. Defaults to false
   * @param [metadata] Additional non-secret data to store with the TDF
   * @param [opts] Test only
   * @param [mimeType] mime type of source. defaults to `unknown`
   * @param [offline] Where to store the policy. Defaults to `false` - which results in `upsert` events to store/update a policy
   * @param [windowSize] - segment size in bytes. Defaults to a million bytes.
   * @param [eo] - (deprecated) entity object
   * @param [payloadKey] - Separate key for payload; not saved. Used to support external party key storage.
   * @return a {@link https://nodejs.org/api/stream.html#stream_class_stream_readable|Readable} a new stream containing the TDF ciphertext, if output is not passed in as a paramter
   */
  async encrypt({
    scope,
    source,
    asHtml,
    metadata,
    mimeType,
    offline,
    windowSize,
    eo,
    payloadKey,
  }: Omit<EncryptParams, 'output'>): Promise<DecoratedReadableStream>;
  async encrypt({
    scope,
    source,
    asHtml,
    metadata,
    mimeType,
    offline,
    output,
    windowSize,
    eo,
    payloadKey,
  }: EncryptParams & { output: NodeJS.WriteStream }): Promise<void>;
  async encrypt({
    scope = { attributes: [], dissem: [] },
    source,
    asHtml = false,
    metadata,
    mimeType,
    offline = false,
    rcaSource,
    windowSize = DEFAULT_SEGMENT_SIZE,
    eo,
    payloadKey,
  }: EncryptParams): Promise<DecoratedReadableStream | void> {
    if (asHtml) {
      if (rcaSource) {
        throw new Error('rca links should be used only with zip format');
      }
      if (!this.readerUrl) {
        throw new Error('html container missing required parameter: [readerUrl]');
      }
    }
    if (rcaSource && !this.kasEndpoint) {
      throw new Error('rca links require a kasEndpoint url to be set');
    }
    const sessionKeys = await this.sessionKeys;
    const kasPublicKey = await this.kasPublicKey;
    const policyObject = this._createPolicyObject(scope);

    // TODO: Refactor underlying builder to remove some of this unnecessary config.

    const tdf = TDF.create()
      .setPrivateKey(sessionKeys.keypair.privateKey)
      .setPublicKey(sessionKeys.keypair.publicKey)
      .setEncryption({
        type: 'split',
        cipher: 'aes-256-gcm',
      })
      .setDefaultSegmentSize(windowSize)
      // set root sig and segment types
      .setIntegrityAlgorithm('hs256', 'gmac')
      .addContentStream(source, mimeType)
      .setPolicy(policyObject)
      .setAuthProvider(this.authProvider);
    if (eo) {
      tdf.setEntity(eo);
    }
    await tdf.addKeyAccess({
      type: offline ? 'wrapped' : 'remote',
      url: this.kasEndpoint,
      publicKey: kasPublicKey,
      metadata,
    });

    const byteLimit = asHtml ? HTML_BYTE_LIMIT : GLOBAL_BYTE_LIMIT;
    const stream = await tdf.writeStream(
      byteLimit,
      !!rcaSource,
      payloadKey,
      this.clientConfig.progressHandler
    );
    // Looks like invalid calls | stream.upsertResponse equals empty array?
    if (rcaSource) {
      stream.policyUuid = policyObject.uuid;
    }
    return stream;
  }

  /**
   * Decrypt TDF ciphertext into plaintext. One of the core operations of the Virtru SDK.
   *
   * @param params
   * @param params.source A data stream object, one of remote, stream types.
   * @param params.rcaSource RCA source information
   * @return a {@link https://nodejs.org/api/stream.html#stream_class_stream_readable|Readable} stream containing the decrypted plaintext.
   * @see DecryptParamsBuilder
   */
  async decrypt({ source, rcaSource }: DecryptParams): Promise<DecoratedReadableStream> {
    const sessionKeys = await this.sessionKeys;
    let entityObject;
    if (this.eas) {
      entityObject = await this.eas.fetchEntityObject({
        publicKey: sessionKeys.keypair.publicKey,
      });
    }
    const tdf = TDF.create()
      .setPrivateKey(sessionKeys.keypair.privateKey)
      .setPublicKey(sessionKeys.keypair.publicKey)
      .setAuthProvider(this.authProvider);
    if (entityObject) {
      tdf.setEntity(entityObject);
    }
    const chunker = await makeChunkable(source);

    // Await in order to catch any errors from this call.
    // TODO: Write error event to stream and don't await.
    return tdf.readStream(
      chunker,
      rcaSource,
      this.clientConfig.progressHandler,
      this.clientConfig.fileStreamServiceWorker
    );
  }

  /*
   * Create a policy object for an encrypt operation.
   */
  _createPolicyObject(scope: Scope): Policy {
    if (scope.policyObject) {
      // use the client override if provided
      return scope.policyObject;
    }
    const policyId = scope.policyId || v4();
    return {
      uuid: policyId,
      body: {
        dataAttributes: scope.attributes || [],
        dissem: scope.dissem || [],
      },
    };
  }
}

export {
  AuthProvider,
  AppIdAuthProvider,
  DecryptParamsBuilder,
  DecryptSource,
  EncryptParamsBuilder,
  HttpRequest,
  fromDataSource,
};
