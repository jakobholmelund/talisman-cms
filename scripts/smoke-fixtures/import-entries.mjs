// Copied into each smoke project and run there, so bare specifiers resolve from the consumer's
// node_modules. Imports every packed entry point given on the command line.
import { register } from 'node:module';

register('./stub-virtual-modules.mjs', import.meta.url);

let failed = 0;
for (const specifier of process.argv.slice(2)) {
  try {
    await import(specifier);
    console.log(`ok   ${specifier}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${specifier}: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}
// Some entries start timers or watchers on import; do not wait for them.
process.exit(failed ? 1 : 0);
