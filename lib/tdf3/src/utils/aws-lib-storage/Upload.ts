import { AbortController, AbortSignal } from '@aws-sdk/abort-controller';
import {
  AbortMultipartUploadCommandOutput,
  CompletedPart,
  CompleteMultipartUploadCommand,
  CompleteMultipartUploadCommandOutput,
  CreateMultipartUploadCommand,
  CreateMultipartUploadCommandOutput,
  PutObjectCommand,
  PutObjectCommandInput,
  PutObjectTaggingCommand,
  S3Client,
  Tag,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { extendedEncodeURIComponent } from '@aws-sdk/smithy-client';
import { Buffer } from 'buffer';
import { EventEmitter } from 'eventemitter3';

import { getChunk } from './chunker.js';
import { BodyDataTypes, Options, Progress } from './types.js';

export interface RawDataPart {
  partNumber: number;
  data: BodyDataTypes;
  lastPart?: boolean;
}

const MIN_PART_SIZE = 1024 * 1024 * 5;

export const byteLength = (input: RawDataPart['data'] | PutObjectCommandInput['Body']) => {
  if (input === null || input === undefined) {
    return 0;
  }
  if (typeof input === 'string') {
    // number of utf-8 encoded bytes in a string
    return Buffer.from(input).byteLength;
  }
  if ('byteLength' in input && typeof input.byteLength === 'number') {
    return input.byteLength;
  } else if ('length' in input && typeof input.length === 'number') {
    return input.length;
  } else if ('size' in input && typeof input.size === 'number') {
    return input.size;
    // } else if ('path' in input && typeof input.path === 'string') {
    //   try {
    //     return ClientDefaultValues.lstatSync(input.path).size;
    //   } catch (error) {
    //     return undefined;
    //   }
  }
  throw new Error(`Unsupported type [${input}]`);
};

export class Upload extends EventEmitter {
  /**
   * S3 multipart upload does not allow more than 10000 parts.
   */
  private MAX_PARTS = 10000;

  // Defaults.
  private queueSize = 4;
  private partSize = MIN_PART_SIZE;
  private leavePartsOnError = false;
  private tags: Tag[] = [];

  private client: S3Client;
  private params: PutObjectCommandInput;

  // used for reporting progress.
  private totalBytes?: number;
  private bytesUploadedSoFar: number;

  // used in the upload.
  private abortController: AbortController;
  private concurrentUploaders: Promise<void>[] = [];
  private createMultiPartPromise?: Promise<CreateMultipartUploadCommandOutput>;

  private uploadedParts: CompletedPart[] = [];
  private uploadId?: string;
  uploadEvent?: string | symbol;

  private isMultiPart = true;
  private singleUploadResult?: CompleteMultipartUploadCommandOutput;

  constructor(options: Options) {
    super();

    // set defaults from options.
    this.queueSize = options.queueSize || this.queueSize;
    this.partSize = options.partSize || this.partSize;
    this.leavePartsOnError = options.leavePartsOnError || this.leavePartsOnError;
    this.tags = options.tags || this.tags;

    this.client = options.client;
    this.params = options.params;

    this.__validateInput();

    // set progress defaults
    this.totalBytes = byteLength(this.params.Body);
    this.bytesUploadedSoFar = 0;
    this.abortController = new AbortController();
  }

  async abort(): Promise<void> {
    /**
     * Abort stops all new uploads and immediately exists the top level promise on this.done()
     * Concurrent threads in flight clean up eventually.
     */
    this.abortController.abort();
  }

  public async done(): Promise<
    CompleteMultipartUploadCommandOutput | AbortMultipartUploadCommandOutput
  > {
    return await Promise.race([
      this.__doMultipartUpload(),
      this.__abortTimeout(this.abortController.signal),
    ]);
  }

  public override on(event: string | symbol, listener: (progress: Progress) => void): this {
    this.uploadEvent = event;
    return super.on(event, listener);
  }

  private async __uploadUsingPut(dataPart: RawDataPart): Promise<void> {
    this.isMultiPart = false;
    const params = { ...this.params, Body: dataPart.data };
    const [putResult, endpoint] = await Promise.all([
      this.client.send(new PutObjectCommand(params)),
      this.client.config.endpoint(),
    ]);

    const locationKey = this.params
      .Key!.split('/')
      .map((segment) => extendedEncodeURIComponent(segment))
      .join('/');
    const locationBucket = extendedEncodeURIComponent(this.params.Bucket!);

    const Location: string = this.client.config.forcePathStyle
      ? `${endpoint.protocol}//${endpoint.hostname}/${locationBucket}/${locationKey}`
      : `${endpoint.protocol}//${locationBucket}.${endpoint.hostname}/${locationKey}`;

    this.singleUploadResult = {
      ...putResult,
      Bucket: this.params.Bucket,
      Key: this.params.Key,
      Location,
    };
    const totalSize = byteLength(dataPart.data);
    this.__notifyProgress({
      loaded: totalSize,
      total: totalSize,
      part: 1,
      Key: this.params.Key,
      Bucket: this.params.Bucket,
    });
  }

  private async __createMultipartUpload(): Promise<void> {
    if (!this.createMultiPartPromise) {
      const createCommandParams = { ...this.params, Body: undefined };
      this.createMultiPartPromise = this.client.send(
        new CreateMultipartUploadCommand(createCommandParams)
      );
    }
    const createMultipartUploadResult = await this.createMultiPartPromise;
    this.uploadId = createMultipartUploadResult.UploadId;
  }

  private async __doConcurrentUpload(
    dataFeeder: AsyncGenerator<RawDataPart, void, undefined>
  ): Promise<void> {
    for await (const dataPart of dataFeeder) {
      if (this.uploadedParts.length > this.MAX_PARTS) {
        throw new Error(
          `Exceeded ${this.MAX_PARTS} as part of the upload to ${this.params.Key} and ${this.params.Bucket}.`
        );
      }

      try {
        if (this.abortController.signal.aborted) {
          return;
        }

        // Use put instead of multi-part for one chunk uploads.
        if (dataPart.partNumber === 1 && dataPart.lastPart) {
          return await this.__uploadUsingPut(dataPart);
        }

        if (!this.uploadId) {
          await this.__createMultipartUpload();
          if (this.abortController.signal.aborted) {
            return;
          }
        }

        const partResult = await this.client.send(
          new UploadPartCommand({
            ...this.params,
            UploadId: this.uploadId,
            Body: dataPart.data,
            PartNumber: dataPart.partNumber,
          })
        );

        if (this.abortController.signal.aborted) {
          return;
        }

        this.uploadedParts.push({
          PartNumber: dataPart.partNumber,
          ETag: partResult.ETag,
          ...(partResult.ChecksumCRC32 && { ChecksumCRC32: partResult.ChecksumCRC32 }),
          ...(partResult.ChecksumCRC32C && { ChecksumCRC32C: partResult.ChecksumCRC32C }),
          ...(partResult.ChecksumSHA1 && { ChecksumSHA1: partResult.ChecksumSHA1 }),
          ...(partResult.ChecksumSHA256 && { ChecksumSHA256: partResult.ChecksumSHA256 }),
        });

        this.bytesUploadedSoFar += byteLength(dataPart.data);
        this.__notifyProgress({
          loaded: this.bytesUploadedSoFar,
          total: this.totalBytes,
          part: dataPart.partNumber,
          Key: this.params.Key,
          Bucket: this.params.Bucket,
        });
      } catch (e) {
        // Failed to create multi-part or put
        if (!this.uploadId) {
          throw e;
        }
        // on leavePartsOnError throw an error so users can deal with it themselves,
        // otherwise swallow the error.
        if (this.leavePartsOnError) {
          throw e;
        }
      }
    }
  }

  private async __doMultipartUpload(): Promise<CompleteMultipartUploadCommandOutput> {
    // Set up data input chunks.
    const dataFeeder = getChunk(this.params.Body, this.partSize);

    // Create and start concurrent uploads.
    for (let index = 0; index < this.queueSize; index++) {
      const currentUpload = this.__doConcurrentUpload(dataFeeder);
      this.concurrentUploaders.push(currentUpload);
    }

    // Create and start concurrent uploads.
    await Promise.all(this.concurrentUploaders);
    if (this.abortController.signal.aborted) {
      throw Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });
    }

    let result;
    if (this.isMultiPart) {
      this.uploadedParts.sort((a, b) => a.PartNumber! - b.PartNumber!);

      const uploadCompleteParams = {
        ...this.params,
        Body: undefined,
        UploadId: this.uploadId,
        MultipartUpload: {
          Parts: this.uploadedParts,
        },
      };
      result = await this.client.send(new CompleteMultipartUploadCommand(uploadCompleteParams));
    } else {
      result = this.singleUploadResult!;
    }

    // Add tags to the object after it's completed the upload.
    if (this.tags.length) {
      await this.client.send(
        new PutObjectTaggingCommand({
          ...this.params,
          Tagging: {
            TagSet: this.tags,
          },
        })
      );
    }

    return result;
  }

  private __notifyProgress(progress: Progress): void {
    if (this.uploadEvent) {
      this.emit(this.uploadEvent, progress);
    }
  }

  private async __abortTimeout(
    abortSignal: AbortSignal
  ): Promise<AbortMultipartUploadCommandOutput> {
    return new Promise((resolve, reject) => {
      abortSignal.onabort = () => {
        const abortError = new Error('Upload aborted.');
        abortError.name = 'AbortError';
        reject(abortError);
      };
    });
  }

  private __validateInput(): void {
    if (!this.params) {
      throw new Error(`InputError: Upload requires params to be passed to upload.`);
    }

    if (!this.client) {
      throw new Error(`InputError: Upload requires a AWS client to do uploads with.`);
    }

    if (this.partSize < MIN_PART_SIZE) {
      throw new Error(
        `EntityTooSmall: Your proposed upload partsize [${this.partSize}] is smaller than the minimum allowed size [${MIN_PART_SIZE}] (5MB)`
      );
    }

    if (this.queueSize < 1) {
      throw new Error(`Queue size: Must have at least one uploading queue.`);
    }
  }
}