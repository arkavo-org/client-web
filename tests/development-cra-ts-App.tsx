import React, { useState } from 'react';
import logo from './logo.svg';
import './App.css';
import {
  AuthProvider,
  AuthProviders,
  Client as Tdf3Client,
  NanoTDFClient
} from '@arkavo-org/client';
import Keycloak from 'keycloak-js';

const kasEndpoint = 'http://localhost/api/kas';
const oidcConfig = {
  url: 'http://localhost/auth',
  realm: 'tdf',
  clientId: 'dcr-test'
}
const keycloak = new Keycloak(oidcConfig);
keycloak.init({
  onLoad: 'login-required'
});

function App() {
  const [count, setCount] = useState(0)
  console.log(keycloak);
  return <div className="App">
    <header className="App-header">
      <img src={logo} className="App-logo" alt="logo" />
      <button onClick={async () => {
        const oidcRefreshConfig = {
          clientId: oidcConfig.clientId,
          refreshToken: keycloak.refreshToken || "a.b.c",
          oidcOrigin: oidcConfig.url + "/realms/" + oidcConfig.realm
        }
        const authProvider: AuthProvider = new AuthProviders.OIDCRefreshTokenProvider(oidcRefreshConfig);
        const client = new Tdf3Client.Client({
          authProvider,
          kasEndpoint: kasEndpoint
        });
        let source = stringToReadableStream("hello world")
        const cipherText = await client.encrypt({
          source: source,
          offline: true,
        });
        console.log(cipherText);
        // let cipherSource: DecryptSource = { type: "stream", location: cipherText.stream };
        // await client.decrypt({ source: cipherSource });
        // nano
        const nanoClient = new NanoTDFClient(authProvider, kasEndpoint);
        const nanoCipherText = await nanoClient.encrypt("hello world");
        await nanoClient.decrypt(nanoCipherText);
        setCount(() => count + 1);
      }}>
        count is {count}
      </button>
      <a
        className="App-link"
        href="https://reactjs.org"
        target="_blank"
        rel="noopener noreferrer"
      >
        Learn React
      </a>
    </header>
  </div>;
}

export default App;

function stringToReadableStream(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(str);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodedData);
      controller.close();
    },
  });
}
