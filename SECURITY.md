# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: [open a draft security advisory](https://github.com/jakobholmelund/talisman-cms/security/advisories/new) for this repository. If GitHub does not let you open one, email the report to [hello@talisman.vision](mailto:hello@talisman.vision) with "Security" in the subject; the address is monitored and reaches the maintainer. Do not open a public issue, pull request or discussion for a vulnerability.

Please include:

- the package and version (`talisman-cms` or an `@talisman-cms/*` plugin), or the commit;
- the configuration involved, such as the auth adapter, plugins and Worker settings, without real secrets;
- steps to reproduce, and the impact you expect.

Test only against your own installation, for example the `playground` in this repository or a site you run. Do not test against sites operated by others.

## What happens next

Replies come in the private advisory, or by email for reports sent by email. Once a fix is released for the affected packages, a security advisory is published. Reporters are credited in it unless they ask not to be.

## Supported versions

Talisman CMS is released as 0.x. Security fixes go into the latest release of each package; there are no backports to older versions. Keep `talisman-cms` and its plugins on matching current versions.

## Scope

This policy covers the packages published from this repository: `talisman-cms`, `@talisman-cms/plugin-ecommerce`, `@talisman-cms/plugin-stripe`, `@talisman-cms/plugin-analytics`, `@talisman-cms/plugin-ui-daisyui` and `@talisman-cms/plugin-ui-starwind`. The `playground` is a local example with placeholder resources, not a deployment. Problems in a particular site's own configuration or hosting belong with that site's operator.
