Every claim from either model classifies into one of four categories
during reconciliation:

| Category     | Condition                                              |
|--------------|--------------------------------------------------------|
| AGREED       | Both models reached the same conclusion                |
| LOCAL-ONLY   | The local host found it, the peer did not              |
| PEER-ONLY    | The peer found it, the local host did not              |
| CONFLICT     | Models reached opposing conclusions                    |

`LOCAL-ONLY` / `PEER-ONLY` are host-neutral — they describe the discovery
side relative to the invoked profile, regardless of which host happens to
be local. The same protocol works in both directions.
