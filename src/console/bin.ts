#!/usr/bin/env node
/**
 * `strutvane-cli` executable. The `strutvane` launcher delegates here; it can also be run
 * directly. All logic lives in `main.ts` (tested); this file only touches the process.
 *
 * @module
 */
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2))
