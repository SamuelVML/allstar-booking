// Writes the WordPress bridge's bundled service map from the Worker catalogue
// (`lib/booking.ts` SERVICES), so the website key → Bookly service ID mapping
// is defined in one place (owner decision D06).
//   node scripts/bookly-service-map.mjs          write the file
//   node scripts/bookly-service-map.mjs --check  exit 1 if the file differs
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const target = 'integrations/bookly/allstar-bookly-bridge/service-map.json';
const source = ts.transpileModule(fs.readFileSync('lib/booking.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = { exports: {} };
vm.runInNewContext(source, { module: m, exports: m.exports, Intl, Date });
const services = Object.fromEntries(m.exports.SERVICES.map(service => [service.id, service.booklyServiceId]));
const expected = `${JSON.stringify({
  generatedFrom: 'lib/booking.ts SERVICES (owner decision D06; regenerate with node scripts/bookly-service-map.mjs)',
  services,
}, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== expected) {
    console.error(`${target} is out of date. Run node scripts/bookly-service-map.mjs`);
    process.exit(1);
  }
  console.log(`${target} matches lib/booking.ts`);
} else {
  fs.writeFileSync(target, expected);
  console.log(`wrote ${target}`);
}
