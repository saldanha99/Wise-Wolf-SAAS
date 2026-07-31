
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import HubApp from './components/hub/HubApp';
import ResetPassword from './components/ResetPassword';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
const RootApp = normalizedPath === '/hub' || normalizedPath.startsWith('/hub/')
  ? HubApp
  : normalizedPath === '/reset-password'
    ? ResetPassword
    : App;
root.render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>
);
