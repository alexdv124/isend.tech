# isend.tech: repository workflow

The owner requires all subsequent completed project changes to be published to
https://github.com/alexdv124/isend.tech so that GitHub stays current.

- Include application source, tests, relevant documentation and sanitized deployment examples.
- After completing a change, run appropriate checks, review the Git diff for secrets and private data, commit and push to the repository. Existing authorization covers these routine updates; do not ask again just to push.
- Check the resulting GitHub Actions run and address failures caused by the change. Report a failed or blocked publication accurately; do not claim GitHub is current until the push succeeds.
- Do not overwrite unrelated user changes or force-push shared history. Respect a later explicit request to hold, inspect only, or keep a change local.
- Never commit SSH keys, passwords, tokens, real environment files, production credentials, private pairing records, user journals or test artifacts containing user data. Use placeholders in deploy examples. A .gitignore is not a substitute for reviewing staged content.
- Publishing source does not itself authorize unrelated production-server changes. Preserve other sites and services on a shared VPS.
