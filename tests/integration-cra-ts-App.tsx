import React, { useState } from 'react';
import logo from './logo.svg';
import './App.css';
import { AuthProvider, AuthProviders, NanoTDFClient } from "@arkavo-org/client";

function App() {
  const [count, setCount] = useState(0)
  const oidcConfig = {clientId: "abacus-localhost", externalJwt: "a.b.c", oidcOrigin: "http://localhost:65432/auth"}
  const authProvider: AuthProvider = new AuthProviders.OIDCExternalJwtProvider(oidcConfig)
  console.log(authProvider)
  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <button onClick={async () => {
          const client = new NanoTDFClient(authProvider, "http://localhost:65432/api/kas");
          await client.encrypt("hello world");
          // FIXME CORS error with quickstart
          // await client.decrypt(cipherText);
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
    </div>
  );
}

export default App;
