import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = fileURLToPath(new URL('../', import.meta.url));
const userConfig = join(homedir(), '.config', 'jinju-buddy');
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
const local = parseEnv(read(join(root, '.env')));
const settings = { ...local, ...process.env };
export const modelEndpoint = settings.BUDDY_HY4_ENDPOINT || '';
export const eventId = settings.BUDDY_EVENT_ID || 's-conference';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(eventId)) throw new Error('活动编号请使用小写字母、数字和短横线');
export const config = {
  id: eventId,
  name: settings.BUDDY_EVENT_NAME || 'S大会',
  port: Number(settings.PORT || 4178),
  host: settings.HOST || '0.0.0.0',
  dir: join(settings.BUDDY_DATA_DIR || join(root, 'data'), eventId),
  localControl: settings.BUDDY_LOCAL_CONTROL !== '0',
  fontDir: settings.BUDDY_FONT_DIR,
  tlsCert: settings.TLS_CERT_FILE,
  tlsKey: settings.TLS_KEY_FILE,
};
export function credentials() {
  const saved = parseEnv(read(join(userConfig, 'asr.env')));
  return {
    appId: settings.TENCENTCLOUD_APP_ID || saved.TENCENTCLOUD_APP_ID,
    secretId: settings.TENCENTCLOUD_SECRET_ID || saved.TENCENTCLOUD_SECRET_ID,
    secretKey: settings.TENCENTCLOUD_SECRET_KEY || saved.TENCENTCLOUD_SECRET_KEY,
    token: modelEndpoint ? (settings.TOKENLINK_API_KEY || read(join(userConfig, 'tencent-tokenhub-key.txt'))) : '',
  };
}
export function hasAsr(keys) {
  return Boolean(/^\d+$/.test(keys.appId || '') && keys.secretId && keys.secretKey);
}

export function providers(keys) {
  return { tencent: hasAsr(keys) };
}
