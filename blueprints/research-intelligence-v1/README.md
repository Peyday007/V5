# Research Intelligence v1 — the design sections a reader authored

These are the seven packet sections `derivePacket` deliberately does **not**
write. Brain composes the question and answers none of this kind: a design
filled in from a template would be indistinguishable from one somebody made,
and `readiness` says so in those words for every section that has no author.

They are inputs the deployed Brain reads by path, which is why they live beside
the blueprint and are copied into the image at `blueprints/` rather than under
`docs/` — see the Dockerfile for why that distinction is load-bearing rather
than tidy. They carry no authority of their own: `putSection` records them as
`PROPOSED` with the evidence they were written from, and nothing about a
section moves a faculty's six dimensions.

Three of the ten sections are absent on purpose. `CAPABILITY_MAP`,
`CURRENT_STATE` and `IMPLEMENTATION_GAPS` are `DERIVED_SECTIONS` — Brain reads
them from its own rows, and a hand-written copy would be a second master for
something the self-model already answers.

Written against the kernel's reading of `Brain_Intelligence_Map.md` §5.1, after
the gap derivation that found every missing requirement sits *after* the
packet's own terminal state: the run itself — plan, fragment, verify, gate,
synthesize, audit — is live and proven, and what no row survives is what the run
learned, what it left open, and what it thinks should be tried next.
