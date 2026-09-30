import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { version as bundledVersion } from '../../src-tauri/tauri.conf.json';

export function KotaVersionLabel() {
  const [version, setVersion] = useState(bundledVersion);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void getVersion().then((currentVersion) => {
      if (active) setVersion(currentVersion);
    }).catch(() => {
      // Keep the bundled version if native metadata is unavailable.
    });
    return () => { active = false; };
  }, []);

  return (
    <span
      className="kota-version-label"
      role="note"
      aria-label={`Kota version ${version}`}
      title={`Kota version ${version}`}
    >
      <span className="kota-version-name">KOTA</span>
      <span className="kota-version-separator" aria-hidden>·</span>
      <span className="kota-version-number">v{version}</span>
    </span>
  );
}
