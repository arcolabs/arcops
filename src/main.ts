// src/main.ts
import { dispatch } from './dispatch';

const code = await dispatch(process.argv.slice(2));
process.exit(code);

// deliberate type error to verify CI gating
const _smokeTypeError: number = 'this is not a number';
