#!/usr/bin/env node

import fs from 'fs';
console.log(fs.readFileSync('README.md', 'utf8'));
