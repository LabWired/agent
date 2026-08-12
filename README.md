# LabWired Agent

Write firmware and test its behavior on a digital twin.

```bash
# macOS / Linux
curl -fsSL https://labwired.com/install | bash
labwired agent
```

```powershell
# Windows (PowerShell)
irm https://labwired.com/install.ps1 | iex
labwired agent
```

Then enter this prompt:

> Blink the LED and test it on the twin.

LabWired Agent can find board information, write firmware, repair failures, and
check expected behavior. It reports what it observed and what it could not test.

LabWired Agent is optional. It does not install LabWired Core. Existing Core
installations and data stay in place.



## Guides

- [Install, update, or remove the Agent](docs/INSTALL.md)
- [Use the Agent for a firmware task](docs/USAGE.md)
- [Understand verification results](docs/VERIFY.md)
- [Develop and test this repository](docs/DEVELOPMENT.md)
- [Legal (Privacy & Terms)](docs/LEGAL.md)


## Skills (domain packs)

| Pack | Job |
|------|-----|
| **golden-path** | Stranger → twin green entry loop |
| **bringup** | Board + part knowledge (`labwired_part` / `labwired_datasheet`) |
| **import-circuit** | Schematic/diagram → twin pack (catalog-honest) |
| **prove** | Twin verify → green only via the twin check |
| **observe** | Plots from run elements |
| **desk-hw** | Flash + serial marker → desk green only |

Twin green and desk green are **separate claims**. Never treat a desk check as twin green. Exact status names: [docs/VERIFY.md](docs/VERIFY.md).

## Privacy & Terms

Hosted LabWired Agent, MCP, and model gateway are covered by:

- [Privacy Policy](https://labwired.com/privacy)
- [Terms of Service](https://labwired.com/terms)

See [docs/LEGAL.md](docs/LEGAL.md). Contact: contact@labwired.com · privacy@labwired.com · security@labwired.com

## License

MIT. See [LICENSE](LICENSE). Open-source kit license is separate from hosted service Terms.
