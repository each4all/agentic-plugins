```bash
NOUN={{noun}}
node "$PLUGIN_ROOT/scripts/tool.mjs" --persona {{name}}
```
{{#capability dispatch_target}}
Record the parent linkage before finishing.
{{/capability}}
{{^capability dispatch_target}}
There is no parent to record.
{{/capability}}
