// 登録した端末の一覧（CA-019）：なくした端末を、別の端末から外す。
import { DEVICE_KIND_LABELS, MAX_DEVICES } from '@clinical-carte/core';
import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from './messages.ts';
import { type DeviceView, listDevices, removeDevice } from './net/api.ts';

export function Devices({ onLeft }: { onLeft: () => void }) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** 「外す」を押して、確かめを待っている端末 */
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void listDevices().then((result) => {
      if (result.ok) setDevices(result.value);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  }, [onLeft]);

  useEffect(load, [load]);

  const remove = (device: DeviceView) => {
    setBusy(true);
    setMessage(null);
    void removeDevice(device.id).then((result) => {
      setBusy(false);
      setAsking(null);
      if (result.ok && device.current) onLeft();
      else if (result.ok || result.error === 'not_found') load();
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  };

  return (
    <section className="card" aria-labelledby="devices-title">
      <h2 id="devices-title">登録した端末</h2>
      <p className="note">
        {String(MAX_DEVICES)} 台まで。なくした端末・使わなくなった端末は、ここで外します。外した端末では、合鍵を入れ直すまで、記録を開けません。
      </p>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {devices === null ? (
        <p className="note">読み込んでいます…</p>
      ) : (
        <ul className="rows" data-testid="devices">
          {devices.map((device) => (
            <li key={device.id} className="row" data-testid="device">
              <div className="row-main">
                <span className="row-title">
                  {DEVICE_KIND_LABELS[device.kind]}
                  {device.current && <span className="tag">この端末</span>}
                </span>
                <span className="row-sub">
                  登録 {device.registeredOn}・最後に使った日 {device.lastUsedOn}
                </span>
              </div>
              {asking === device.id ? (
                <span className="row-actions">
                  <button
                    className="button danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      remove(device);
                    }}
                    data-testid="confirm-remove"
                  >
                    {device.current ? 'この端末を外す' : '外す'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAsking(null);
                    }}
                  >
                    やめる
                  </button>
                </span>
              ) : (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setAsking(device.id);
                  }}
                  data-testid="remove"
                >
                  外す
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
