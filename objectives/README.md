# Objectives the factory may be given

One JSON file per software objective, committed so that it is reviewable in a
diff and is *inside the image* — which is the whole reason this directory is at
the root rather than under `docs/`, where `.dockerignore` would have kept it out.
The deployed Brain reads the file by path, so a path that only exists in the
repository is a path the container cannot open, which is exactly how the first
one failed.

An objective is prose. It stays in a file rather than becoming a workflow input
because prose in an input is prose that has to survive a dispatcher, a shell and
an SSH session, and because a file can be read before it is approved.

Nothing here is a secret and nothing here authorizes anything. Submitting one
records a change request and pins a commit; a person still has to approve it
before any work exists, and `services/factory/repositoryEnvelope.ts` still
decides whether the repository it names may be worked in at all.
