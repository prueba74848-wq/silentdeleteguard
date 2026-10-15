(function (exports, patcher, metro, metroCommon, pluginApi) {
"use strict";
const { FluxDispatcher } = metroCommon;
const { findByStoreName } = metro;
const patchBefore = patcher.before;

// ---- options ----
const NOTE_TEXT = "This message was deleted silently";
const MAX_TRACKED = 300; // protected messages remembered (oldest are forgotten first)

let MessageStore;
const patches = [];
const protectedMsgs = new Map(); // original messageId -> channelId
let alerted = false;

function reportOnce(where, e) {
	console.error(`[SilentDeleteGuard] ${where}`, e);
	if (alerted) return;
	alerted = true;
	alert(`[SilentDeleteGuard → ${where}] died\n${e?.stack}`);
}

// the fake "automod blocked this" event that makes Discord keep the message and show a note
function placeholder(channelId, id) {
	return {
		type: "MESSAGE_EDIT_FAILED_AUTOMOD",
		messageData: {
			type: 1,
			message: { channelId, messageId: id },
		},
		errorResponseBody: {
			code: 200000,
			message: NOTE_TEXT,
		},
	};
}

// SilentDelete signature: a MESSAGE_CREATE whose nonce equals the ID of a message that is
// already delivered (not one of our own optimistic "SENDING" messages), from the same author,
// with a different real ID. Normally this only happens for your own pending messages.
function handleCreate(args, event) {
	const msg = event.message;
	if (!msg || !msg.nonce || !msg.id) return;
	if (String(msg.nonce) === String(msg.id)) return;

	const channelId = msg.channel_id || event.channelId;
	if (!channelId) return;

	const existing = MessageStore.getMessage(channelId, String(msg.nonce));
	if (!existing || existing.id !== String(msg.nonce)) return;
	if (existing.state === "SENDING" || existing.state === "SEND_FAILED") return;
	if (existing.author?.id !== msg.author?.id) return;

	// remember the original so its later delete is turned into a "kept" note
	protectedMsgs.set(existing.id, channelId);
	if (protectedMsgs.size > MAX_TRACKED) protectedMsgs.delete(protectedMsgs.keys().next().value);

	// strip the nonce so the placeholder can't overwrite the original in the store.
	// the placeholder then shows up as its own message and is removed by its own delete.
	args[0] = { ...event, message: { ...msg, nonce: undefined } };
	return args;
}

function handleDelete(args, event) {
	if (!event.id || !event.channelId) return;
	if (!protectedMsgs.has(event.id)) return; // normal deletes (and the placeholder's) go through
	protectedMsgs.delete(event.id);
	args[0] = placeholder(event.channelId, event.id);
	return args;
}

function handleBulkDelete(args, event) {
	const ids = Array.isArray(event.ids) ? event.ids : [];
	if (!ids.length || !event.channelId) return;

	const keep = ids.filter((id) => protectedMsgs.has(id));
	if (!keep.length) return;

	const drop = ids.filter((id) => !protectedMsgs.has(id));
	for (const id of keep) protectedMsgs.delete(id);

	let rest;
	if (drop.length) {
		args[0] = { ...event, ids: drop };
		rest = keep;
	} else {
		args[0] = placeholder(event.channelId, keep[0]);
		rest = keep.slice(1);
	}
	if (rest.length) {
		setTimeout(() => {
			for (const id of rest) {
				try {
					FluxDispatcher.dispatch(placeholder(event.channelId, id));
				} catch (e) {
					console.error("[SilentDeleteGuard] bulk placeholder", e);
				}
			}
		}, 0);
	}
	return args;
}

const plugin = {
	onUnload() {
		for (const unpatch of patches) unpatch();
		patches.length = 0;
		protectedMsgs.clear();
	},
	onLoad() {
		try {
			patches.push(
				patchBefore("dispatch", FluxDispatcher, (args) => {
					try {
						const event = args[0];
						const type = event?.type;
						if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_DELETE" && type !== "MESSAGE_DELETE_BULK") return;

						if (!MessageStore) MessageStore = findByStoreName("MessageStore");

						if (type === "MESSAGE_CREATE") return handleCreate(args, event);
						if (type === "MESSAGE_DELETE") return handleDelete(args, event);
						return handleBulkDelete(args, event);
					} catch (e) {
						reportOnce("dispatcher patch", e);
					}
				})
			);
		} catch (e) {
			console.error(e);
			alert(`[SilentDeleteGuard] dead\n${e.stack}`);
		}
	},
};

exports.default = plugin;
Object.defineProperty(exports, "__esModule", { value: true });
return exports;
})({}, vendetta.patcher, vendetta.metro, vendetta.metro.common, vendetta.plugin);
