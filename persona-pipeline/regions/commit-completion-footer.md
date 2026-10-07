The runtime completion footer is **code-emitted** on the commit path
(ADR-0039): the driver's terminal write fires the ADR-0031 session-handoff
sidecar, which prints the footer on stderr. Do **not** hand-compose a second
one. The footer is advisory + pointer-only and fail-closed, and it never
mutates host session context. The close path prints none — its projection
would read the unmoved HEAD as a blocked archive and advise a commit — so the
Completion above names the next step instead.
