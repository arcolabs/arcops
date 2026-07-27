// src/main.ts
import './lib/pipe-guard'; // KEH-278 B: must run before any output so a closed downstream pipe can never crash the process mid-action
import { dispatch } from './dispatch';

const code = await dispatch(process.argv.slice(2));
process.exit(code);
