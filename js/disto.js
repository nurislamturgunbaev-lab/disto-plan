// Подключение Leica DISTO (X3, X4, D2, D110, D510, D810 …) по Bluetooth Low Energy (Web Bluetooth).
// Сервис DISTO: 3ab10100-f831-4395-b29d-570977d5bf94
//   3ab10101 — расстояние (float32, little-endian, метры)
//   3ab10102 — единицы
//   3ab1010d — «базовое измерение» на новых моделях (первые 4 байта — float32 LE, метры)
//   3ab10109 — команды (на части моделей)
// Подписываемся на все характеристики с notify/indicate и разбираем значения.

export const DISTO_SERVICE = '3ab10100-f831-4395-b29d-570977d5bf94';
const U = (s) => `3ab1${s}-f831-4395-b29d-570977d5bf94`;
const CH_DISTANCE = U('0101');
const CH_UNIT = U('0102');
const CH_BASIC = U('010d');
const CH_COMMAND = U('0109');

export class Disto extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.chars = [];
    this.cmd = null;
    this.state = 'off'; // off | connecting | on
    this.last = { v: null, t: 0 };
    this.log = [];
    this._manualDisconnect = false;
  }

  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  _set(state, msg) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, msg } }));
  }

  _log(s) {
    const line = new Date().toLocaleTimeString() + ' ' + s;
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.dispatchEvent(new CustomEvent('log', { detail: line }));
  }

  async connect() {
    if (!Disto.supported()) throw new Error('Web Bluetooth не поддерживается этим браузером');
    this._manualDisconnect = false;
    this._set('connecting', 'Выбор устройства…');
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'DISTO' }, { services: [DISTO_SERVICE] }],
        optionalServices: [DISTO_SERVICE, 'battery_service', 'device_information'],
      });
    } catch (e) {
      this._set('off', 'Устройство не выбрано');
      throw e;
    }
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    await this._open();
  }

  async _open() {
    this._set('connecting', 'Подключение к ' + (this.device.name || 'DISTO') + '…');
    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(DISTO_SERVICE);
    const chars = await svc.getCharacteristics();
    this.chars = chars;
    this.cmd = null;
    for (const ch of chars) {
      const uuid = ch.uuid.toLowerCase();
      const p = ch.properties;
      this._log(`характеристика ${uuid.slice(4, 8)} ${p.notify ? 'N' : ''}${p.indicate ? 'I' : ''}${p.read ? 'R' : ''}${p.write || p.writeWithoutResponse ? 'W' : ''}`);
      if (uuid === CH_COMMAND && (p.write || p.writeWithoutResponse)) this.cmd = ch;
      if (p.notify || p.indicate) {
        try {
          ch.addEventListener('characteristicvaluechanged', (ev) => this._onValue(uuid, ev.target.value));
          await ch.startNotifications();
        } catch (e) {
          this._log('не удалось подписаться на ' + uuid.slice(4, 8) + ': ' + e.message);
        }
      }
    }
    this._set('on', this.device.name || 'DISTO');
    this.battery().catch(() => {});
  }

  async battery() {
    try {
      const s = await this.server.getPrimaryService('battery_service');
      const c = await s.getCharacteristic('battery_level');
      const v = await c.readValue();
      const pct = v.getUint8(0);
      this.dispatchEvent(new CustomEvent('battery', { detail: pct }));
      return pct;
    } catch (e) { return null; }
  }

  _onValue(uuid, dv) {
    const bytes = [];
    for (let i = 0; i < dv.byteLength; i++) bytes.push(dv.getUint8(i).toString(16).padStart(2, '0'));
    this._log(`← ${uuid.slice(4, 8)} [${bytes.join(' ')}]`);
    if (uuid === CH_UNIT) return;
    let meters = null;
    if ((uuid === CH_DISTANCE || uuid === CH_BASIC) && dv.byteLength >= 4) {
      meters = dv.getFloat32(0, true);
    } else if (dv.byteLength === 4 && uuid.startsWith('3ab101')) {
      const f = dv.getFloat32(0, true);
      if (f > 0.04 && f < 400) meters = f; // неизвестная характеристика, но похожа на расстояние
    }
    if (meters == null || !isFinite(meters) || meters <= 0 || meters > 1000) return;
    meters = Math.round(meters * 10000) / 10000;
    // одно и то же измерение может прийти по двум характеристикам
    const now = Date.now();
    if (this.last.v === meters && now - this.last.t < 700) return;
    this.last = { v: meters, t: now };
    this.dispatchEvent(new CustomEvent('measure', { detail: { meters, source: uuid.slice(4, 8) } }));
  }

  /** Запуск измерения с телефона (работает не на всех моделях) */
  async trigger() {
    if (!this.cmd) throw new Error('Дистанционный запуск не поддерживается — нажмите кнопку на DISTO');
    const data = new TextEncoder().encode('g');
    if (this.cmd.properties.write) await this.cmd.writeValue(data);
    else await this.cmd.writeValueWithoutResponse(data);
  }

  async _onDisconnect() {
    this._log('соединение потеряно');
    if (this._manualDisconnect) { this._set('off', 'Отключено'); return; }
    this._set('connecting', 'Переподключение…');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1000 + i * 1500));
      try { await this._open(); return; } catch (e) { this._log('повтор ' + (i + 1) + ': ' + e.message); }
    }
    this._set('off', 'Связь потеряна — подключите снова');
  }

  disconnect() {
    this._manualDisconnect = true;
    try { this.device?.gatt?.disconnect(); } catch (e) { /* ignore */ }
    this._set('off', 'Отключено');
  }
}
