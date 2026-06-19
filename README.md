# krson

Binary format for high-throughput systems. **schema.get() is 2.9x faster than JSON.parse()**.

## Install

```bash
npm install krson-js
```

## Quick Start

```javascript
const { defineSchema } = require('krson');

// Define schema once at startup
const userSchema = defineSchema({
  name:   'string',
  age:    'varint',
  score:  'float64',
  active: 'bool',
});

// Encode
const buf = userSchema.encode({ name: 'Alice', age: 30, score: 98.5, active: true });

// Full decode
const obj = userSchema.decode(buf);

// Single field — 2.9x faster than JSON.parse() + field access
const age = userSchema.get(buf, 'age');  // → 30
```

## Benchmark (1,000,000 iterations)

| Operation | JSON | KRSON | Result |
|---|---|---|---|
| encode | 656ms | ~500ms | comparable |
| decode | 1051ms | ~800ms | comparable |
| **schema.get()** | **992ms** | **340ms** | **2.9x FASTER ✅** |
| payload size | 123 bytes | 97 bytes | **21% smaller ✅** |

## When to use

✅ You receive large API responses but only need 1-3 fields  
✅ High-frequency microservice calls (>100k/sec)  
✅ Smaller payloads matter (bandwidth cost)  

## GitHub

https://github.com/utkarshbanka/KRSON

## License

MIT
