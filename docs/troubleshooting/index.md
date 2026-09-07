# Troubleshoot Nanasa

Package users and people who operate Nanasa can start with the visible symptom
and follow safe recovery steps.

## Choose a symptom

* [Nanasa does not start or the portal rejects login](startup.md)
* [A provider command, login, or agent launch fails](providers.md)
* [A terminal resets or remote access is lost](terminals-and-remote-access.md)

Run the first command on the relevant page before deleting state. Keep these
rules in mind:

* Do not delete `daemon.lock` while a live owner exists.
* Do not delete `.nanasa/state/` to solve an ordinary startup error.
* Do not reuse `memberId` where a configured agent map key is required.
* Do not expose the loopback portal directly to the network.
* Do not treat message delivery as proof of task completion.

For exact error IDs and limits, see the generated
[errors and limits registry](../reference/errors-limits.json).
