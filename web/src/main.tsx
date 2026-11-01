import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './panels';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

// Register the PWA service worker. Only needed in production builds — the dev
// server doesn't serve /sw.js, and registering against Vite's HMR shell would
// just produce console noise.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
