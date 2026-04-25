// src/main.ts
import { dispatch } from './dispatch';

const code = await dispatch(process.argv.slice(2));
process.exit(code);
