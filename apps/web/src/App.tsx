import { useCallback, useEffect, useState } from 'react';
import { Landing } from './components/Landing';
import { RoomPage } from './components/RoomPage';

export function App() {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(to);
  }, []);

  const m = path.match(/^\/r\/([A-Za-z0-9]{4,10})\/?$/);
  if (m) {
    const code = m[1]!.toUpperCase();
    return <RoomPage key={code} code={code} navigate={navigate} />;
  }
  return <Landing navigate={navigate} />;
}
