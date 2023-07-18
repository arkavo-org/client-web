import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'
import { AuthProvider, AuthProviders } from "@arkavo-org/client";
import { NanoTDFClient } from '../src';

function App() {
  const authProvider: AuthProvider = new AuthProviders.OIDCExternalJwtProvider({clientId: "", externalJwt: "", oidcOrigin: ""})
  console.log(authProvider)
  const [count, setCount] = useState(0)

  return (
    <>
      <div>
        <a href="https://vitejs.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={async () => {
          const client = new Client(authProvider, "http://localhost:65432/api/kas");
          let cipherText = await client.encrypt("hello world");
          await client.decrypt(cipherText);
          const nanoClient = new NanoTDFClient(authProvider, "http://localhost:65432/api/kas");
          cipherText = await nanoClient.encrypt("hello world");
          await nanoClient.decrypt(cipherText);
          setCount(() => count + 1);
        }}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  )
}

export default App
