# Owner login profile images — scoped change

## Requested outcome

Replace human owner placeholders with Google-login or uploaded profile images, using the supplied images as temporary mocks.

## Source difference

- The supplied three-profile image is stored locally at `public/assets/profiles/mock-google-login-profiles.png`.
- Danie, Mira, and Jon are deterministically mapped to the first, second, and third uploaded profile images.
- Human owner badges render circular photos instead of generic user glyphs.
- The shared thin chrome bezel remains around every profile image.
- Automated agents retain the robot identity icon so people and agents are not visually confused.

## Verification

- Production compilation passes.
- The mock image can later be replaced by a Google account photo or an explicitly uploaded per-user image without changing badge layout.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
