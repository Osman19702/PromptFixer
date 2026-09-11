# Installing PromptFixer (Windows)

PromptFixer is a desktop app. You download one file, run it, and it works — there is nothing to
install first, no Node.js, no command line, no account.

## Requirements

- Windows 10 or 11, 64-bit
- About 3.5 GB of free disk space (the app is ~350 MB; the language model it downloads on first run
  is 2.5 GB)
- 8 GB of RAM, or 4 GB with the smaller "lite" model. A GPU is used automatically if you have one
  (NVIDIA, AMD or Intel); without one it still works, more slowly.

## Install

1. Download **PromptFixer-0.1.0-win-x64.exe** from the link you were given.
2. Double-click it. Windows may show a blue **"Windows protected your PC"** screen because the
   installer is not yet code-signed. Click **More info**, then **Run anyway**. (If you want to check
   the file first, its SHA-256 is published next to the download link.)
3. Choose an install folder or accept the default, and finish. PromptFixer opens by itself and adds a
   Start menu entry.

## First run

The app opens on an empty editor. Linting and scoring work immediately: paste any prompt and you
will see a score and a list of findings as you type, with nothing sent anywhere.

To use **Fix prompt**, the app needs its language model once:

1. In the top-right provider selector, **Local model** is already chosen.
2. The results pane shows **"Download the local model"** with the size (2.5 GB). Click **Download**.
   You can keep using the linter while it runs, and you can pause and resume; it survives a restart.
3. When it finishes, the model loads (about 15 seconds the first time) and **Fix prompt** becomes
   available. From here on the app works with no internet connection at all.

If your machine has less than 8 GB of RAM, pick the **lite** model in the tier selector next to the
provider before downloading — it is 1 GB and runs on anything.

## Where your data lives

- Your saved prompts (the Library): `%APPDATA%\PromptFixer\data\library.json`
- The downloaded model: `%USERPROFILE%\.promptfixer\models\`

Both survive uninstalling and reinstalling the app. Use **Library → Export** to move your prompts to
another machine and **Import** to merge them back; nothing you already have is ever overwritten.

## Optional: cloud providers

If you would rather use Claude, OpenAI, Gemini, OpenRouter or Ollama, create a text file named
`.env` in `%APPDATA%\PromptFixer\` containing your key, for example `ANTHROPIC_API_KEY=sk-ant-…`,
and restart the app. The provider appears in the selector. Keys stay on your machine; the app never
displays them.

## Uninstall

Settings → Apps → PromptFixer → Uninstall. This removes the app only; your library and the model
are left in place. Delete the two folders above if you want them gone too.

## Trouble?

- **"Prompt is too long for the local model"** — the local model has an 8k-token context. Shorten
  the prompt or use a cloud provider for that one.
- **Slow fixes (over a minute)** — you are probably on CPU. Check the chip under the editor after the
  first fix: it names the backend. Switch to the lite model, or add a cloud provider.
- **The download stopped** — click Download again; it resumes where it left off.
