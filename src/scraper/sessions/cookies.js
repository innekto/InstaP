import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cookiesPath = path.resolve(__dirname, '../../../cookies.json');

let cookies = [];
try {
  const raw = fs.readFileSync(cookiesPath, 'utf8');
  cookies = JSON.parse(raw);
} catch (err) {
  throw new Error(`Не удалось прочитать cookies: ${cookiesPath}. ${err.message}`);
}

export default cookies;
