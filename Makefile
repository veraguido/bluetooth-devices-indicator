UUID    := bluetooth-devices-indicator@guido.local
SRC     := $(CURDIR)
EXT_DIR := $(if $(XDG_DATA_HOME),$(XDG_DATA_HOME),$(HOME)/.local/share)/gnome-shell/extensions
DEST    := $(EXT_DIR)/$(UUID)

.PHONY: help install link uninstall enable disable reload check pack logs

help:
	@echo "Targets:"
	@echo "  make install    Symlink this repo into the extensions dir and enable it (dev)"
	@echo "  make uninstall  Disable and remove the symlink"
	@echo "  make enable     Enable the extension"
	@echo "  make disable    Disable the extension"
	@echo "  make check      Syntax-check extension.js and metadata.json"
	@echo "  make pack       Build a distributable zip (gnome-extensions pack)"
	@echo "  make logs       Follow the GNOME Shell journal"
	@echo
	@echo "NOTE: on Wayland, log out and back in for the shell to load the extension."
	@echo "      on X11, restart the shell with Alt+F2 -> r -> Enter."

install: link enable
	@echo
	@echo "Installed. On Wayland: log out/in. On X11: Alt+F2 -> r -> Enter."

link:
	@mkdir -p "$(EXT_DIR)"
	@rm -rf "$(DEST)"
	@ln -s "$(SRC)" "$(DEST)"
	@echo "Linked $(DEST) -> $(SRC)"

uninstall: disable
	@rm -rf "$(DEST)"
	@echo "Removed $(DEST)"

enable:
	@gnome-extensions enable "$(UUID)" && echo "Enabled $(UUID)" || true

disable:
	@gnome-extensions disable "$(UUID)" 2>/dev/null || true
	@echo "Disabled $(UUID)"

check:
	@node --check extension.js 2>/dev/null && echo "extension.js: module syntax OK" \
		|| (which node >/dev/null 2>&1 || echo "node not found; skipping JS check")
	@python3 -c "import json;json.load(open('metadata.json'));print('metadata.json: valid')"

pack:
	@gnome-extensions pack --force \
		--extra-source=README.md \
		"$(SRC)"
	@echo "Built $(UUID).shell-extension.zip"

logs:
	@journalctl --user -f -o cat /usr/bin/gnome-shell
