// Copyright 2017 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var RoonApi          = require("node-roon-api"),
    RoonApiSettings  = require('node-roon-api-settings'),
    RoonApiStatus    = require('node-roon-api-status'),
    RoonApiTransport = require('node-roon-api-transport');

const EXPECTED_CONFIG_REV = 2;
const ALARM_COUNT = 5;

const ACTION_NONE = -1;
const ACTION_STOP = 0;
const ACTION_PLAY = 1;
const ACTION_TRANSFER = 2;
const ACTION_STANDBY = 3;

const SUN     = 0;
const MON     = 1;
const TUE     = 2;
const WED     = 3;
const THU     = 4;
const FRI     = 5;
const SAT     = 6;
const ONCE    = 7;
const DAILY   = 8;
const MON_FRI = 9;
const WEEKEND = 10;

const TRANS_INSTANT    = 0;
const TRANS_FADING     = 1;
const TRANS_TRACKBOUND = 2;

var core = undefined;
var transport = undefined;
var waiting_zones = {};
var pending_alarms = [];
var timeout_id = [];
var interval_id = [];
var fade_volume = [];

var roon = new RoonApi({
    extension_id:        'com.theappgineer.alarm-clock',
    display_name:        'Alarm Clock',
    display_version:     '0.5.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://github.com/TheAppgineer/roon-extension-alarm-clock',

    core_paired: function(core_) {
        core = core_;
        transport = core.services.RoonApiTransport;
        transport.subscribe_zones((response, msg) => {
            let zones = [];

            if (response == "Subscribed") {
                zones = msg.zones;
            } else if (response == "Changed") {
                if (msg.zones_changed) {
                    zones = msg.zones_changed;
                }
                if (msg.zones_added) {
                    zones = msg.zones_added;
                }
            }

            if (zones) {
                zones.forEach(function(zone) {
                    const on_match = waiting_zones[zone.zone_id];

                    if (on_match && on_match.properties) {
                        let match = false;

                        if (on_match.properties.now_playing) {
                            const seek_position = on_match.properties.now_playing.seek_position;

                            // Sometimes a seek_position is missed by the API, allow 1 off
                            match = (seek_position != undefined && zone.now_playing &&
                                     (seek_position == zone.now_playing.seek_position ||
                                      seek_position + 1 == zone.now_playing.seek_position));
                        }
                        if (!match) {
                            const play_allowed = on_match.properties.is_play_allowed;
                            const pause_allowed = on_match.properties.is_pause_allowed;
                            const state = on_match.properties.state;

                            match = ((play_allowed != undefined && play_allowed == zone.is_play_allowed) ||
                                     (pause_allowed != undefined && pause_allowed == zone.is_pause_allowed) ||
                                     (state != undefined && state == zone.state));
                        }
                        if (match) {
                            if (on_match.cb) {
                                on_match.cb(zone);
                            }
                            delete waiting_zones[zone.zone_id];
                        }
                    }
                });
            }
        });
    },
    core_unpaired: function(core_) {
        core = undefined;
        transport = undefined;
    }
});

var wake_settings = roon.load_config("settings") || {
    selected_timer: 0
};

function on_zone_property_changed(zone_id, properties, cb) {
    waiting_zones[zone_id] = { properties: properties, cb: cb };
}

function makelayout(settings) {
    var l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let selector = {
        type:    "dropdown",
        title:   "Selected Alarm",
        values:  [],
        setting: "selected_timer"
    };

    for (let i = 0; i < ALARM_COUNT; i++) {
        selector.values.push({
            title: get_alarm_title(settings, i),
            value: i
        });
    }
    l.layout.push(selector);

    let i = settings.selected_timer;
    let group = {
        type:        "group",
        items:       [],
    };
    group.title = selector.values[i].title;

    group.items.push({
        type:    "dropdown",
        title:   "Timer",
        values:  [
            { title: "Disabled", value: false },
            { title: "Enabled",  value: true  }
        ],
        setting: "timer_active_" + i
    });

    if (settings["timer_active_" + i]) {
        let v = {
            type:    "zone",
            title:   "Zone",
            setting: "zone_" + i
        };
        group.items.push(v);

        let zone = settings["zone_" + i];
        let current_volume = null;

        if (zone) {
            // Get volume information from output
            current_volume = get_current_volume_by_output_id(zone.output_id);

            if (current_volume && settings["wake_volume_" + i] == null) {
                settings["wake_volume_" + i] = current_volume.max;
            }
        }

        group.items.push({
            type:    "dropdown",
            title:   "Action",
            values:  [
                { title: "Play",     value: ACTION_PLAY     },
                { title: "Stop",     value: ACTION_STOP     },
                { title: "Standby",  value: ACTION_STANDBY  },
                { title: "Transfer", value: ACTION_TRANSFER }
            ],
            setting: "wake_action_" + i
        });

        v = {
            type:    "dropdown",
            title:   "Day(s)",
            values:  [
                { title: "Once",               value: ONCE    },
                { title: "Daily",              value: DAILY   },
                { title: "Monday till Friday", value: MON_FRI },
                { title: "Weekend",            value: WEEKEND },
                { title: "Sunday",             value: SUN },
                { title: "Monday",             value: MON },
                { title: "Tuesday",            value: TUE },
                { title: "Wednesday",          value: WED },
                { title: "Thursday",           value: THU },
                { title: "Friday",             value: FRI },
                { title: "Saturday",           value: SAT }
            ],
            setting: "wake_day_" + i
        };
        group.items.push(v);

        v = {
            type:    "string",
            title:   "Alarm Time",
            setting: "wake_time_" + i
        };
        group.items.push(v);

        const day = settings["wake_day_" + i];
        let allow_rel_timer = 0;

        if (day == ONCE) {
            // 'Once' implies no repeat
            settings["repeat_" + i] = false;
            allow_rel_timer = 1;
            v.title += " (use '+' for relative alarm)";
        }

        let valid_time = validate_time_string(settings["wake_time_" + i], allow_rel_timer);

        if (valid_time) {
            settings["wake_time_" + i] = valid_time.friendly;
        } else {
            if (allow_rel_timer) {
                v.error = "Time should conform to format: [+]hh:mm[am|pm]";
            } else {
                v.error = "Time should conform to format: hh:mm[am|pm]";
            }
            l.has_error = true;
        }

        let action = settings["wake_action_" + i];

        if ((action == ACTION_PLAY || action == ACTION_TRANSFER) && current_volume) {
            let v = {
                type:    "integer",
                min:     current_volume.min,
                max:     current_volume.max,
                title:   "Volume",
                setting: "wake_volume_" + i
            };
            let volume = settings["wake_volume_" + i];
            if (current_volume.type == "db") {
                v.title += " (dB)"
            }
            if (volume < v.min || volume > v.max) {
                v.error = "Wake Volume must be between " + v.min + " and " + v.max + ".";
                l.has_error = true;
            }
            group.items.push(v);
        }

        let transitions = {
            type:    "dropdown",
            title:   "Transition Type",
            values:  [ { title: "Instant", value: TRANS_INSTANT } ],
            setting: "transition_type_" + i
        };

        if (action != ACTION_TRANSFER) {
            if (current_volume) {
                transitions.values.push({
                    title: "Fading",
                    value: TRANS_FADING
                });
            }
            if (action == ACTION_STOP || action == ACTION_STANDBY) {
                transitions.values.push({
                    title: "Track Boundary",
                    value: TRANS_TRACKBOUND
                });
            }
        } else {
            v = {
                type:    "zone",
                title:   "Transfer Zone",
                setting: "transfer_zone_" + i
            };
            group.items.push(v);
        }

        if (transitions.values.length > 1) {
            group.items.push(transitions);

            if (settings["transition_type_" + i] != TRANS_INSTANT) {
                v = {
                    type:    "integer",
                    min:     0,
                    max:     30,
                    title:   "Transition Time",
                    setting: "transition_time_" + i
                };
                let trans_time = settings["transition_time_" + i];
                if (trans_time < v.min || trans_time > v.max) {
                    v.error = "Transition Time must be between " + v.min + " and " + v.max + " minutes.";
                    l.has_error = true;
                }
                group.items.push(v);
            }
        }

        // Hide repeat for 'Once'
        if (day != ONCE) {
            v = {
                type:    "dropdown",
                title:   "Repeat",
                values:  [
                    { title: "Disabled", value: false },
                    { title: "Enabled",  value: true  }
                ],
                setting: "repeat_" + i
            };
            group.items.push(v);
        }
    }

    l.layout.push(group);

    return l;
}

function set_defaults(settings, index, force) {
    if (force || settings["timer_active_" + index] == null) {
        settings["timer_active_"    + index] = false;
        settings["zone_"            + index] = null;
        settings["wake_action_"     + index] = ACTION_PLAY;
        settings["wake_day_"        + index] = ONCE;
        settings["wake_time_"       + index] = "07:00";
        settings["wake_volume_"     + index] = null;
        settings["transition_type_" + index] = TRANS_INSTANT;
        settings["transition_time_" + index] = "0";
        settings["transfer_zone_"   + index] = null;
        settings["repeat_"          + index] = false;

        return true;
    }

    return false;
}

function validate_config(settings) {
    const config_rev = settings["config_rev"];
    let corrected = false;

    for (let i = 0; i < ALARM_COUNT; i++) {
        if ((corrected = set_defaults(settings, i)) == false) {
            // Check for configuration updates
            switch (config_rev) {
                case undefined:
                    // Update to configuration revision 1
                    const wake_time = "" + settings["wake_time_hours_" + i] +
                                      ":" + settings["wake_time_minutes_" + i];

                    settings["wake_time_" + i] = wake_time;
                    corrected = true;
                    break;
                case 1:
                    const fade_time = settings["fade_time_" + i];

                    settings["transition_type_" + i] = (fade_time > 0 ? TRANS_FADING : TRANS_INSTANT);
                    settings["transition_time_" + i] = fade_time;

                    // Cleanup obsolete settings
                    delete settings["wake_time_hours_" + i];
                    delete settings["wake_time_minutes_" + i];
                    delete settings["fade_time_" + i];

                    corrected = true;
                    break;
                case EXPECTED_CONFIG_REV:
                    // This is the expected configuration revision
                    break;
                default:
                    // Configuration is too new, we have to revert to the defaults of this revision
                    corrected = set_defaults(settings, i, true);
                    break;
            }
        }
    }

    settings["config_rev"] = EXPECTED_CONFIG_REV;

    return corrected;
}

function get_alarm_title(settings, index) {
    const active = settings["timer_active_" + index];
    const zone = settings["zone_" + index];
    const day = settings["wake_day_" + index];
    let valid_time = validate_time_string(settings["wake_time_" + index], day == ONCE);
    let title;

    if (active && zone && valid_time) {
        const day_string = [
            " on Sunday",               // SUN
            " on Monday",               // MON
            " on Tueday",               // TUE
            " on Wednesday",            // WED
            " on Thursday",             // THU
            " on Friday",               // FRI
            " on Saturday",             // SAT
            "",                         // ONCE
            " daily",                   // DAILY
            " on Monday till Friday",   // MON_FRI
            " in weekend"               // WEEKEND
        ];
        const action = settings["wake_action_" + index];
        const transfer_zone = settings["transfer_zone_" + index];
        let repeat_string = "";
        let action_string = get_action_string(action);

        if (settings["repeat_" + index]) {
            switch (day) {
                case ONCE:
                case DAILY:
                    break;
                case MON_FRI:
                    repeat_string = " (weekly)";
                    break;
                default:
                    repeat_string = "s";    // Append 's' to day
                    break;
            }
        } else if (day == MON_FRI || day == DAILY) {
            repeat_string = " (this week)";
        }

        title = zone.name + ": " + action_string + day_string[day] + repeat_string;

        if (action == ACTION_TRANSFER && transfer_zone) {
            title += " to " + transfer_zone.name;
        }

        if (valid_time.relative) {
            title += " in " + (valid_time.hours ? valid_time.hours + "h and " : "");
            title += valid_time.minutes + "min";
        } else {
            title += " @ " + valid_time.friendly;
        }
    } else {
        title = "Alarm " + (index + 1) + " not set";
    }

    return title;
}

function get_action_string(action) {
    let action_string = "";

    switch (action) {
        case ACTION_STANDBY:
            action_string = "Standby";
            break;
        case ACTION_STOP:
            action_string = "Stop";
            break;
        case ACTION_PLAY:
            action_string = "Play";
            break;
        case ACTION_TRANSFER:
            action_string = "Transfer";
            break;
    }

    return action_string;
}

function add_pending_alarm(entry) {
    let i;

    for (i = 0; i < pending_alarms.length; i++) {
        if (pending_alarms[i].timeout > entry.timeout) {
            break;
        }
    }

    pending_alarms.splice(i, 0, entry);
}

function get_pending_alarms_string() {
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let alarm_string = "";

    for (let i = 0; i < pending_alarms.length; i++) {
        const date_time = new Date(pending_alarms[i].timeout);

        alarm_string += pending_alarms[i].action + " on " + day[date_time.getDay()];
        alarm_string += " @ " + date_time.toLocaleTimeString() + "\n";
    }

    if (alarm_string.length) {
        alarm_string = "Pending Alarms:\n" + alarm_string;
    } else {
        alarm_string = "No active Alarms";
    }

    return alarm_string;
}

function validate_time_string(time_string, allow_relative) {
    let relative = (time_string.charAt(0) == "+");

    if (relative && !allow_relative) {
        return null;
    }

    let valid_time_string = time_string.substring(relative);
    let separator_index = valid_time_string.indexOf(":");
    let hours = "0";

    // Extract hours
    if (separator_index == 1 || separator_index == 2 ) {
        hours = valid_time_string.substring(0, separator_index);
    } else if (relative) {
        // Outside expected range, no hours specified
        separator_index = -1;
    } else {
        return null;
    }

    // Extract minutes
    let minutes = valid_time_string.substring(separator_index + 1, separator_index + 3);

    // Check ranges
    if (isNaN(hours) || hours < 0 || hours > 23) {
        return null;
    }

    if (isNaN(minutes) || minutes < 0 || minutes > 59) {
        return null;
    }

    // Extract 24h/12h clock type
    let is_am = false;
    let is_pm = false;
    let am_pm = "";

    if (!relative) {
        let am_pm_index = separator_index + 1 + minutes.length;
        am_pm = valid_time_string.substring(am_pm_index, am_pm_index + 2);
        is_am = (am_pm.toLowerCase() == "am");
        is_pm = (am_pm.toLowerCase() == "pm");

        // Check hour range
        if (is_am || is_pm) {
            if (hours < 1 || hours > 12) {
                return null;
            }
        }
    }

    if (hours.length == 1) {
        hours = "0" + hours;
    }

    if (minutes.length == 1) {
        minutes = "0" + minutes;
    }

    // Create human readable string
    let friendly = (relative ? "+" : "") + hours + ":" + minutes;
    if (is_am || is_pm) {
        friendly += am_pm;
    }

    // Convert to 24h clock type
    if (is_am && hours == 12) {
        hours -= 12;
    } else if (is_pm && hours < 12) {
        hours = +hours + 12;
    }

    return {
        relative: relative,
        hours:    +hours,
        minutes:  +minutes,
        friendly: friendly
    };
}

function get_current_volume_by_output_id(output_id) {
    return get_current_volume(transport.zone_by_output_id(output_id), output_id);
}

function get_current_volume(zone, output_id) {
    let volume = null;

    if (zone && zone.outputs) {
        zone.outputs.forEach(function(output) {
            if (output.output_id == output_id) {
                volume = output.volume;
            }
        });
    }

    return volume;
}

function set_timer(reset) {
    const now = new Date();
    let settings = wake_settings;

    if (reset) {
        pending_alarms = [];
    } else {
        // Remove expired alarms
        for (let i = pending_alarms.length - 1; i >= 0; i--) {
            if (pending_alarms[i].timeout <= now.getTime()) {
                pending_alarms.splice(0, i + 1);
                break;
            }
        }
    }

    for (let i = 0; i < ALARM_COUNT; i++) {
        if (reset || timeout_id[i] == null) {
            if (settings["timer_active_" + i] && settings["zone_" + i]) {
                const action = settings["wake_action_" + i];
                const wake_day = settings["wake_day_" + i];
                const fade_time = (settings["transition_type_" + i] == TRANS_FADING ?
                                   +settings["transition_time_" + i] : 0);
                let date = new Date(now);

                // Configuration is already validated at this point, get processed fields
                let valid_time = validate_time_string(settings["wake_time_" + i], wake_day == ONCE);

                date.setSeconds(0);
                date.setMilliseconds(0);

                let timeout_time = date.getTime();

                if (valid_time.relative) {
                    timeout_time += (valid_time.hours * 60 + valid_time.minutes) * 60 * 1000;
                } else {
                    let tz_offset = date.getTimezoneOffset();
                    let day = date.getDay();
                    let days_to_skip = 0;

                    date.setHours(valid_time.hours);
                    date.setMinutes(valid_time.minutes);
                    timeout_time = date.getTime();

                    if (fade_time && action == ACTION_PLAY) {
                        // Subtract fade time to reach the configured volume at the configured time
                        timeout_time -= fade_time * 60 * 1000;
                    }

                    if (wake_day < 7) {
                        days_to_skip = (wake_day + 7 - day) % 7;
                    }

                    if (days_to_skip == 0 && timeout_time < Date.now()) {
                        // Time has passed for today
                        if (wake_day < 7) {
                            // Next week
                            days_to_skip = 7;
                        } else {
                            // Tomorrow
                            days_to_skip = 1;
                            day = (day + 1) % 7;
                        }
                    }

                    if (wake_day == MON_FRI) {
                        switch (day) {
                            case SUN:
                                // Sunday
                                days_to_skip += 1;
                                break;
                            case SAT:
                                // Saterday
                                days_to_skip += 2;
                                break;
                        }
                    } else if (wake_day == WEEKEND && day > SUN && day < SAT) {
                        days_to_skip += SAT - day;
                    }

                    timeout_time += days_to_skip * 24 * 60 * 60 * 1000;
                    date = new Date(timeout_time);
                    tz_offset -= date.getTimezoneOffset();

                    if (tz_offset) {
                        timeout_time -= tz_offset * 60 * 1000;
                    }
                }
                let action_string = settings["zone_" + i].name + ": ";
                action_string += get_action_string(action);

                add_pending_alarm( { timeout: timeout_time, action: action_string } );

                timeout_time -= Date.now();

                if (timeout_id[i] != null) {
                    // Clear pending timeout
                    clearTimeout(timeout_id[i]);
                }

                timeout_id[i] = setTimeout(timer_timed_out, timeout_time, i);
            } else if (timeout_id[i] != null) {
                // Clear pending timeout
                clearTimeout(timeout_id[i]);
                timeout_id[i] = null;
            }
        }
    }

    // Update status
    svc_status.set_status(get_pending_alarms_string(), false);
}

function timer_timed_out(index) {
    let settings = wake_settings;

    timeout_id[index] = null;

    if (core) {
        const output = settings["zone_" + index];
        let zone = transport.zone_by_output_id(output.output_id);

        if (zone) {
            const action = settings["wake_action_" + index];
            let postponed = false;

            if (zone.state == 'playing') {
                const trans_time = (settings["transition_type_" + index] == TRANS_TRACKBOUND ?
                                    +settings["transition_time_" + index] * 60 : 0);
                const now_playing = zone.now_playing;

                if (trans_time > 0 && now_playing && (action == ACTION_STOP || action == ACTION_STANDBY)) {
                    const length = now_playing.length;
                    const properties = {
                        now_playing:     { seek_position: 0 },
                        state:           'stopped',
                        is_play_allowed: true
                    };

                    if (length && (length - now_playing.seek_position < trans_time)) {
                        on_zone_property_changed(zone.zone_id, properties, function(zone) {
                            control(settings, zone, output, index);
                        });

                        postponed = true;
                    }
                }
            } else if (action == ACTION_PLAY && !zone.is_play_allowed && zone.is_previous_allowed) {
                // Start off with previous track
                transport.control(output, 'previous', function(error) {
                    if (!error) {
                        on_zone_property_changed(zone.zone_id, { is_play_allowed: true }, function(zone) {
                            control(settings, zone, output, index);

                            // Turn radio function on to keep the music going
                            transport.change_settings(zone, { auto_radio: true });
                        });
                    }
                });

                postponed = true;
            }

            if (!postponed) {
                control(settings, zone, output, index);
            }
        }
    }

    const date = new Date();
    const day = date.getDay();
    const wake_day = settings["wake_day_" + index];

    if (settings["repeat_" + index] == false &&
        ((wake_day <= ONCE) ||
         (wake_day == WEEKEND && day == SUN) ||
         (wake_day == MON_FRI && day == FRI) ||
         (wake_day == DAILY && day == SAT))) {
        // Disable this timer
        settings["timer_active_" + index] = false;
        roon.save_config("settings", settings);
    }

    set_timer(false);
}

function control(settings, zone, output, index) {
    const fade_time = (settings["transition_type_" + index] == TRANS_FADING ?
                       +settings["transition_time_" + index] : 0);
    const current_volume = get_current_volume(zone, output.output_id);
    let end_volume = settings["wake_volume_" + index];
    let action = settings["wake_action_" + index];

    if (fade_time > 0 && current_volume && action != ACTION_TRANSFER) {
        // Take care of fading
        let start_volume;

        if (zone.state == 'playing') {
            start_volume = current_volume.value;
        } else {
            start_volume = current_volume.min;
        }

        if (action == ACTION_STANDBY || action == ACTION_STOP) {
            end_volume = current_volume.min;
        }

        if (end_volume != start_volume) {
            let ms_per_step = (fade_time * 60 * 1000) / Math.abs(end_volume - start_volume);

            if (interval_id[index] != null) {
                clearInterval(interval_id[index]);
            }

            interval_id[index] = setInterval(take_fade_step, ms_per_step,
                                                index, start_volume, end_volume);

            if (zone.state == 'playing' &&
                (action == ACTION_STANDBY || action == ACTION_STOP)) {
                // Remain playing during fade out
                action = ACTION_NONE;
            }

            end_volume = start_volume;
            fade_volume[index] = start_volume;
        }
    }

    switch (action) {
        case ACTION_PLAY:
            // Set wake volume, even if already playing
            transport.change_volume(output, "absolute", end_volume);

            if (zone.state != 'playing') {
                transport.control(output, 'play');
            }
            break;
        case ACTION_STOP:
            if (zone.state == 'playing') {
                transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');
            }
            break;
        case ACTION_STANDBY:
            transport.standby(output, {}, function(error) {
                if (error) {
                    console.log("Output doesn't support standby");

                    if (zone.state == 'playing') {
                        transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');
                    }
                }
            });
            break;
        case ACTION_TRANSFER:
            const transfer_zone = settings["transfer_zone_" + index];

            // Set volume for the zone we transfer to
            transport.change_volume(transfer_zone, "absolute", end_volume);
            transport.transfer_zone(output, transfer_zone);
            break;
        case ACTION_NONE:
        default:
            break;
    }
}

function take_fade_step(index, start_volume, end_volume) {
    let output = wake_settings["zone_" + index];
    let step = (start_volume < end_volume ? 1 : -1);
    let zone = transport.zone_by_output_id(output.output_id);
    const current_volume = get_current_volume(zone, output.output_id);

    // Detect volume control collisions, allow for 1 step volume set back
    if (current_volume && current_volume.value - fade_volume[index] > 1) {
        // Somebody else is turning the knob as well, hands off
        clearInterval(interval_id[index]);
        interval_id[index] = null;
        console.log("Fading terminated for alarm " + (index + 1));
    } else if (zone.state != 'playing') {
        // Postpone fading in case data is still loading
        if (zone.state != 'loading') {
            // Playback is stopped manually
            clearInterval(interval_id[index]);
            interval_id[index] = null;

            // Restore start volume
            transport.change_volume(output, "absolute", start_volume);
        }
    } else if (fade_volume[index] != end_volume) {
        // Fade one step
        fade_volume[index] += step;
        transport.change_volume(output, "absolute", fade_volume[index]);
    } else {
        // Level reached, clear interval
        clearInterval(interval_id[index]);
        interval_id[index] = null;

        const action = wake_settings["wake_action_" + index];

        if (action == ACTION_STOP || action == ACTION_STANDBY) {
            // Stop playback
            transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');

            on_zone_property_changed(zone.zone_id, { is_play_allowed: true }, function(zone) {
                // Restore start volume
                transport.change_volume(output, "absolute", start_volume, function(error) {
                    if (!error && action == ACTION_STANDBY) {
                        // Switch to standby
                        transport.standby(output, {}, function(error) {
                            if (error) {
                                console.log("Output doesn't support standby");
                            }
                        });
                    }
                });
            });
        }
    }
}

function init() {
    for (let i = 0; i < ALARM_COUNT; i++) {
        timeout_id.push(null);
        interval_id.push(null);
        fade_volume.push(null);
    }

    if (validate_config(wake_settings)) {
        roon.save_config("settings", wake_settings);
    }

    set_timer(true);
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(wake_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            wake_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", wake_settings);

            set_timer(true);
        }
    }
});

var svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services:   [ RoonApiTransport ],
    provided_services:   [ svc_settings, svc_status ]
});

init();
roon.start_discovery();
