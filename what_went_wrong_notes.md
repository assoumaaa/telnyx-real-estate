# What Went Wrong

This file documents the blockers I encountered while working through the challenge and how I solved each one.
It is handwritten by me (without any AI assistance, except for document formatting and phrasing) to give you a real idea of my thought process.

## 1. Setup

Initially, following the opencode installation command from the site installed the latest version (2.0.23):

```bash
bun install -g --trust @opencode/cli
```

This runs fine, but the only issue is adding the Telnyx plugin to a version above 2.0.23.

```bash
opencode plugin @telnyx/opencode
```

Would give me:

```
Unknown subcommand "@telnyx/opencode" for "opencode plugin"
```

```bash
opencode plugin list
```

Would show me the Telnyx plugin, but with no version or ID.

At this point I already suspected a version mismatch. I checked with AI to verify, and that turned out to be correct.

To validate this, I checked the current version of opencode and compared it with the dependency version on npm. You can clearly see in the `package.json` that it refers to `"@opencode-ai/plugin": "^1.2.27"`. This would work fine for versions under 2.0.00, but since we are at 2.0.23, it initially didn't work.

I then removed the old opencode and did this instead:

```bash
bun install -g --trust opencode-ai@1.18.34
```

After that, I ran the commands given in the gist to log in with my Telnyx key and run an openweight model.
