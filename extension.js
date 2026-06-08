import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BLUEZ_BUS = 'org.bluez';
const OBJ_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const UPOWER_IFACE = 'org.freedesktop.UPower';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';

// Force a BoxLayout to lay its children out left-to-right. Recent GNOME Shell
// defaults St.BoxLayout to a vertical orientation, and the actor-level
// `orientation`/`vertical` properties are deprecated — the reliable lever is
// the layout manager's orientation. Fall back to the old property on shells
// that predate the layout-manager API.
function setHorizontal(box) {
    try {
        box.layout_manager.orientation = Clutter.Orientation.HORIZONTAL;
    } catch (_e) {
        try {
            box.vertical = false;
        } catch (_e2) {
            // Nothing else to try; leave the default orientation.
        }
    }
}

// Extract a normalised uppercase MAC address from either a BlueZ object path
// (/org/bluez/hci0/dev_34_B1_EB_EB_F3_E5) or a HID native-path
// (hid-34:b1:eb:eb:f3:e5-battery).  Returns null if no MAC is found.
function macFromPath(path) {
    let m = path.match(/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})$/);
    if (m)
        return m[1].replace(/_/g, ':').toUpperCase();
    m = path.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/);
    if (m)
        return m[1].toUpperCase();
    return null;
}

// Battery thresholds → colour. Returns [r, g, b].
function batteryColor(pct) {
    if (pct <= 20)
        return [0.93, 0.27, 0.27]; // red
    if (pct <= 50)
        return [0.95, 0.69, 0.13]; // amber
    return [0.30, 0.78, 0.40];     // green
}

// A small vertical bar that fills from the bottom according to a percentage.
const BatteryBar = GObject.registerClass(
class BatteryBar extends St.DrawingArea {
    _init(percentage) {
        super._init({
            style_class: 'bt-battery-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._percentage = percentage;
        this.connect('repaint', this._onRepaint.bind(this));
    }

    setPercentage(percentage) {
        if (this._percentage === percentage)
            return;
        this._percentage = percentage;
        this.queue_repaint();
    }

    _onRepaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pct = Math.max(0, Math.min(100, this._percentage));

        // Track / background.
        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // Fill from the bottom up.
        const fillH = Math.round((h * pct) / 100);
        if (fillH > 0) {
            const [r, g, b] = batteryColor(pct);
            cr.setSourceRGBA(r, g, b, 1.0);
            cr.rectangle(0, h - fillH, w, fillH);
            cr.fill();
        }

        cr.$dispose();
    }
});

// One panel entry: device-type icon + (optional) battery bar, with a hover tooltip.
const DeviceEntry = GObject.registerClass(
class DeviceEntry extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'bt-device-entry',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setHorizontal(this);

        // Always-horizontal wrapper so icon + bar stay side-by-side
        // regardless of the parent panel orientation (horizontal or vertical).
        // Use St.Widget + explicit Clutter.BoxLayout to prevent the panel from
        // overriding the orientation through St.BoxLayout's internal logic.
        this._innerBox = new St.Widget({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                spacing: 2,
            }),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._innerBox);

        this._icon = new St.Icon({
            style_class: 'bt-device-icon',
            icon_size: 13,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._innerBox.add_child(this._icon);

        this._bar = new BatteryBar(0);
        this._innerBox.add_child(this._bar);

        this._label = '';
        this._tooltip = null;
        this._tooltipTimeoutId = 0;

        this.connect('notify::hover', this._onHoverChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));
    }

    // info = { name, iconName, percentage|null }
    update(info) {
        this._label = info.name;

        this._icon.gicon = new Gio.ThemedIcon({
            names: [
                `${info.iconName}-symbolic`,
                info.iconName,
                'bluetooth-active-symbolic',
            ],
        });

        if (info.percentage === null || info.percentage === undefined) {
            this._bar.visible = false;
        } else {
            this._bar.visible = true;
            this._bar.setPercentage(info.percentage);
        }

        // Refresh tooltip text if it happens to be visible.
        if (this._tooltip)
            this._tooltip.text = this._tooltipText(info.percentage);
    }

    _tooltipText(percentage) {
        if (percentage === null || percentage === undefined)
            return this._label;
        return `${this._label} — ${percentage}%`;
    }

    _onHoverChanged() {
        if (this.hover) {
            this._tooltipTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 350, () => {
                    this._showTooltip();
                    this._tooltipTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            this._cancelTooltipTimeout();
            this._hideTooltip();
        }
    }

    _showTooltip() {
        const pct = this._bar.visible ? this._bar._percentage : null;

        if (!this._tooltip) {
            this._tooltip = new St.Label({style_class: 'bt-tooltip'});
            this._tooltip.hide();
            Main.layoutManager.addTopChrome(this._tooltip);
        }
        this._tooltip.text = this._tooltipText(pct);

        const [x, y] = this.get_transformed_position();
        const [, natWidth] = this._tooltip.get_preferred_width(-1);
        // Centre the tooltip under the entry, clamped to the monitor.
        const monitor = Main.layoutManager.primaryMonitor;
        let tx = x + this.width / 2 - natWidth / 2;
        tx = Math.max(monitor.x + 4,
            Math.min(tx, monitor.x + monitor.width - natWidth - 4));
        this._tooltip.set_position(Math.round(tx), Math.round(y + this.height + 4));
        this._tooltip.show();
    }

    _hideTooltip() {
        if (this._tooltip)
            this._tooltip.hide();
    }

    _cancelTooltipTimeout() {
        if (this._tooltipTimeoutId) {
            GLib.source_remove(this._tooltipTimeoutId);
            this._tooltipTimeoutId = 0;
        }
    }

    _onDestroy() {
        this._cancelTooltipTimeout();
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }
});

const BluetoothDevicesIndicator = GObject.registerClass(
class BluetoothDevicesIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Bluetooth Devices Indicator', true);

        this._box = new St.BoxLayout({
            style_class: 'bt-indicator-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        setHorizontal(this._box);
        this.add_child(this._box);

        this._entries = new Map(); // device object path → DeviceEntry
        this._bus = Gio.DBus.system;
        this._subscriptions = [];
        this._refreshTimeoutId = 0;

        // Hidden until at least one device is connected.
        this.hide();
        this._subscribeSignals();
        this._refresh();
    }

    _subscribeSignals() {
        const sub = (bus, iface, signal, cb) =>
            this._bus.signal_subscribe(
                bus, iface, signal, null, null,
                Gio.DBusSignalFlags.NONE, cb);

        this._subscriptions.push(
            sub(BLUEZ_BUS, OBJ_MANAGER_IFACE, 'InterfacesAdded',
                () => this._scheduleRefresh()),
            sub(BLUEZ_BUS, OBJ_MANAGER_IFACE, 'InterfacesRemoved',
                () => this._scheduleRefresh()),
            sub(BLUEZ_BUS, PROPS_IFACE, 'PropertiesChanged',
                (conn, sender, path, iface, signal, params) => {
                    const [changedIface] = params.deepUnpack();
                    if (changedIface === DEVICE_IFACE ||
                        changedIface === BATTERY_IFACE)
                        this._scheduleRefresh();
                }),
            sub(UPOWER_BUS, PROPS_IFACE, 'PropertiesChanged',
                (conn, sender, path, iface, signal, params) => {
                    const [changedIface] = params.deepUnpack();
                    if (changedIface === UPOWER_DEVICE_IFACE)
                        this._scheduleRefresh();
                }));
    }

    // Coalesce bursts of D-Bus signals into a single refresh.
    _scheduleRefresh() {
        if (this._refreshTimeoutId)
            return;
        this._refreshTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 250, () => {
                this._refreshTimeoutId = 0;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _refresh() {
        let bluezObjects = null;
        let upowerMap = null;

        const tryRebuild = () => {
            if (bluezObjects !== null && upowerMap !== null)
                this._rebuild(bluezObjects, upowerMap);
        };

        // BlueZ: get all managed objects (devices + battery interfaces).
        this._bus.call(
            BLUEZ_BUS, '/', OBJ_MANAGER_IFACE, 'GetManagedObjects',
            null, new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    [bluezObjects] = conn.call_finish(res).recursiveUnpack();
                } catch (_e) {
                    bluezObjects = {};
                }
                tryRebuild();
            });

        // UPower: enumerate devices, then read NativePath + Percentage for each.
        this._bus.call(
            UPOWER_BUS, UPOWER_PATH, UPOWER_IFACE, 'EnumerateDevices',
            null, new GLib.VariantType('(ao)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                let paths;
                try {
                    [paths] = conn.call_finish(res).recursiveUnpack();
                } catch (_e) {
                    paths = [];
                }

                if (paths.length === 0) {
                    upowerMap = new Map();
                    tryRebuild();
                    return;
                }

                const map = new Map();
                let remaining = paths.length;
                const done = () => {
                    if (--remaining === 0) {
                        upowerMap = map;
                        tryRebuild();
                    }
                };

                for (const devPath of paths) {
                    this._bus.call(
                        UPOWER_BUS, devPath, PROPS_IFACE, 'GetAll',
                        new GLib.Variant('(s)', [UPOWER_DEVICE_IFACE]),
                        new GLib.VariantType('(a{sv})'),
                        Gio.DBusCallFlags.NONE, -1, null,
                        (conn2, res2) => {
                            try {
                                const [props] = conn2.call_finish(res2).recursiveUnpack();
                                const nativePath = props['NativePath'];
                                const pct = props['Percentage'];
                                if (nativePath !== undefined && pct !== undefined) {
                                    const mac = macFromPath(nativePath);
                                    if (mac)
                                        map.set(mac, Math.round(pct));
                                }
                            } catch (_e) {}
                            done();
                        });
                }
            });
    }

    _rebuild(objects, upowerMap) {
        // Collect connected devices in a stable order (by object path).
        const devices = [];
        for (const path of Object.keys(objects).sort()) {
            const ifaces = objects[path];
            const dev = ifaces[DEVICE_IFACE];
            if (!dev || dev.Connected !== true)
                continue;

            const battery = ifaces[BATTERY_IFACE];
            let percentage = null;
            if (battery && typeof battery.Percentage === 'number') {
                percentage = battery.Percentage;
            } else {
                const mac = macFromPath(path);
                if (mac && upowerMap.has(mac))
                    percentage = upowerMap.get(mac);
            }

            devices.push({
                path,
                name: dev.Alias || dev.Name || 'Unknown device',
                iconName: dev.Icon || 'bluetooth',
                percentage,
            });
        }

        const seen = new Set();
        for (const info of devices) {
            let entry = this._entries.get(info.path);
            if (!entry) {
                entry = new DeviceEntry();
                this._entries.set(info.path, entry);
                this._box.add_child(entry);
            }
            entry.update(info);
            seen.add(info.path);
        }

        // Drop entries for devices that are no longer connected.
        for (const [path, entry] of this._entries) {
            if (!seen.has(path)) {
                entry.destroy();
                this._entries.delete(path);
            }
        }

        // Hide the whole indicator when there's nothing to show.
        this.visible = this._entries.size > 0;
    }

    destroy() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];

        for (const entry of this._entries.values())
            entry.destroy();
        this._entries.clear();

        super.destroy();
    }
});

export default class BluetoothDevicesExtension extends Extension {
    enable() {
        this._indicator = new BluetoothDevicesIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
