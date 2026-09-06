# dsh-oauth-mac-install

One-command installer for Dockyard DSH.

```sh
npx -y dsh-oauth-mac-install@latest
```

The installer checks for `dsh` and `pnpm`, installs the currently verified DSH
runtime when `dsh` is missing, and then installs the prebuilt
`dsh-oauth-mac` package into the `web` profile. Restart the running DSH
Web profile after installation so its bundle layer is loaded.

The plugin is macOS-only and requires Node.js 22.19+ or Node.js 24+.
