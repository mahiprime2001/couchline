import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyTheme } from './lib/theme';

applyTheme(); // the saved light/dark choice and accent colour, before anything is drawn

// Not wrapped in StrictMode on purpose: room joins have side effects (create flag, sockets).
createRoot(document.getElementById('root')!).render(<App />);
