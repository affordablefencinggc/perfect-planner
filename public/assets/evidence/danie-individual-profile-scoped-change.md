# Danie individual profile — scoped change

## Requested outcome

Use the newly supplied individual login card as Danie’s current mock profile image.

## Source difference

- The supplied image is stored locally at `public/assets/profiles/danie-profile-mock.png`.
- Danie now resolves to the individual image instead of the temporary three-photo strip.
- CSS crops only the circular portrait region; the YODA card label and surrounding card chrome do not appear in the small owner badge.
- The shared chrome profile bezel remains visible; the supplied image's own presence indicator stays inside the photo crop.
- Mira and Jon continue using their prior mock images until individual login images are supplied.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
