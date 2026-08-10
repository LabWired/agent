# LabWired Agent

Write firmware and test its behavior on a digital twin.

```bash
curl -fsSL https://labwired.com/install/agent | bash
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

## License

MIT. See [LICENSE](LICENSE).
