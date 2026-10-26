require('dotenv').config();

const path = require('node:path');
const Database = require('better-sqlite3');
const {
	Client,
	EmbedBuilder,
	GatewayIntentBits,
	PermissionFlagsBits,
} = require('discord.js');

if (!process.env.DISCORD_TOKEN) {
	throw new Error('DISCORD_TOKEN is required in the environment.');
}

const db = new Database(path.resolve(process.env.DATABASE_PATH || 'pomodobot.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
	CREATE TABLE IF NOT EXISTS channels (
		guild_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		focus_time INTEGER NOT NULL,
		break_time INTEGER NOT NULL,
		repeat_count INTEGER NOT NULL,
		cycles INTEGER NOT NULL DEFAULT 1,
		phase TEXT NOT NULL DEFAULT 'focus',
		ends_at INTEGER,
		active INTEGER NOT NULL DEFAULT 1,
		auto_mute INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (guild_id, channel_id)
	);

	CREATE TABLE IF NOT EXISTS muted_members (
		guild_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		PRIMARY KEY (guild_id, channel_id, user_id),
		FOREIGN KEY (guild_id, channel_id)
			REFERENCES channels (guild_id, channel_id)
	);
`);

const getChannel = db.prepare(
	'SELECT * FROM channels WHERE guild_id = ? AND channel_id = ?',
);
const getActiveChannels = db.prepare('SELECT * FROM channels WHERE active = 1');
const getMutedMembers = db.prepare(
	'SELECT user_id FROM muted_members WHERE guild_id = ? AND channel_id = ?',
);
const getMutedMember = db.prepare(
	'SELECT 1 FROM muted_members WHERE guild_id = ? AND channel_id = ? AND user_id = ?',
);
const getMemberMuteChannels = db.prepare(
	'SELECT channel_id FROM muted_members WHERE guild_id = ? AND user_id = ?',
);
const saveMutedMember = db.prepare(
	'INSERT OR IGNORE INTO muted_members (guild_id, channel_id, user_id) VALUES (?, ?, ?)',
);
const forgetMutedMember = db.prepare(
	'DELETE FROM muted_members WHERE guild_id = ? AND channel_id = ? AND user_id = ?',
);

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const timers = new Map();
const EMBED_COLORS = {
	focus: 0xD97745,
	break: 0x299A8B,
	info: 0x526D82,
	error: 0xC75363,
};

function createEmbed(title, description, color, fields = []) {
	const embed = new EmbedBuilder()
		.setColor(color)
		.setAuthor({ name: 'POMODORO SESSION' })
		.setTitle(title)
		.setDescription(description)
		.setTimestamp();
	if (fields.length) embed.addFields(fields);
	return embed;
}

function replyEmbed(interaction, title, description, color = EMBED_COLORS.info, fields = []) {
	return interaction.reply({
		embeds: [createEmbed(title, description, color, fields)],
		ephemeral: true,
	});
}

function channelKey(guildId, channelId) {
	return `${guildId}:${channelId}`;
}

function clearTimer(guildId, channelId) {
	const key = channelKey(guildId, channelId);
	for (const timer of timers.get(key) || []) clearTimeout(timer);
	timers.delete(key);
}

function getUpcomingPhase(session) {
	if (session.phase === 'starting') return 'focus';
	if (session.phase === 'focus') return 'break';
	if (session.repeat_count > 0 && session.cycles >= session.repeat_count) return 'complete';
	return 'focus';
}

async function announceUpcomingPhase(session) {
	const current = getChannel.get(session.guild_id, session.channel_id);
	if (!current?.active || current.phase !== session.phase || current.ends_at !== session.ends_at) return;

	const channel = client.channels.cache.get(session.channel_id);
	if (!channel?.isTextBased()) return;

	const upcomingPhase = getUpcomingPhase(session);
	const cycle = session.phase === 'break' ? session.cycles + 1 : session.cycles;
	const details = [
		{ name: 'Voice channel', value: `<#${session.channel_id}>`, inline: true },
		{ name: 'Siklus', value: session.repeat_count === 0 ? `${cycle} / ∞` : `${cycle} / ${session.repeat_count}`, inline: true },
	];

	if (upcomingPhase === 'complete') {
		await channel.send({
			embeds: [createEmbed(
				'Pomodoro selesai dalam 10 detik',
				'Sesi istirahat terakhir akan berakhir. Terima kasih sudah menjaga ritme fokus.',
				EMBED_COLORS.info,
				details,
			)],
			allowedMentions: { parse: [] },
		});
		return;
	}

	const focusStarting = upcomingPhase === 'focus';
	const duration = focusStarting ? session.focus_time : session.break_time;
	await channel.send({
		embeds: [createEmbed(
			`${focusStarting ? 'Focus' : 'Break'} dimulai dalam 10 detik`,
			focusStarting
				? `Bersiap kembali fokus selama **${duration} menit**.`
				: `Selesaikan pekerjaanmu. Waktu istirahat **${duration} menit** segera dimulai.`,
			focusStarting ? EMBED_COLORS.focus : EMBED_COLORS.break,
			details,
		)],
		allowedMentions: { parse: [] },
	});
}

function scheduleSession(session) {
	clearTimer(session.guild_id, session.channel_id);
	if (!session.active || !session.ends_at) return;

	const remaining = session.ends_at - Date.now();
	const noticeTimer = setTimeout(() => {
		announceUpcomingPhase(session)
			.catch((error) => console.error('Could not send Pomodoro phase notification:', error));
	}, Math.max(0, remaining - 10_000));
	const transitionTimer = setTimeout(() => {
		advanceSession(session.guild_id, session.channel_id)
			.catch((error) => console.error('Failed to advance Pomodoro session:', error));
	}, Math.max(0, Math.min(remaining, 2_147_000_000)));
	timers.set(channelKey(session.guild_id, session.channel_id), [noticeTimer, transitionTimer]);
}

async function getGuildMember(guild, userId) {
	return guild.members.cache.get(userId) || guild.members.fetch(userId).catch(() => null);
}

async function applyMute(guild, channelId, member) {
	if (member.voice.channelId !== channelId) return;
	const session = getChannel.get(guild.id, channelId);
	if (!session?.active || !session.auto_mute || session.phase !== 'focus') return;

	if (member.voice.serverMute) return;

	try {
		saveMutedMember.run(guild.id, channelId, member.id);
		await member.voice.setMute(true, 'Pomodoro focus session');
	} catch (error) {
		forgetMutedMember.run(guild.id, channelId, member.id);
		console.error(`Could not server-mute ${member.id} in ${channelId}:`, error.message);
	}
}

async function releaseMute(guild, channelId, userId, member) {
	if (!getMutedMember.get(guild.id, channelId, userId)) return;

	const target = member || await getGuildMember(guild, userId);
	if (!target || !target.voice.channelId) return;

	try {
		if (target.voice.serverMute) {
			await target.voice.setMute(false, 'Pomodoro focus ended');
		}
		forgetMutedMember.run(guild.id, channelId, userId);
	} catch (error) {
		console.error(`Could not release server mute for ${userId}:`, error.message);
	}
}

async function releaseChannelMutes(guildId, channelId) {
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return;

	for (const { user_id: userId } of getMutedMembers.all(guildId, channelId)) {
		await releaseMute(guild, channelId, userId);
	}
}

async function reconcileChannel(session) {
	const guild = client.guilds.cache.get(session.guild_id);
	const channel = guild?.channels.cache.get(session.channel_id);
	if (!guild || !channel?.isVoiceBased()) return;

	if (session.active && session.auto_mute && session.phase === 'focus') {
		for (const member of channel.members.values()) {
			await applyMute(guild, session.channel_id, member);
		}
		return;
	}

	await releaseChannelMutes(session.guild_id, session.channel_id);
}

async function advanceSession(guildId, channelId) {
	let session = getChannel.get(guildId, channelId);
	if (!session?.active) {
		clearTimer(guildId, channelId);
		return;
	}

	const now = Date.now();
	while (session.active && session.ends_at <= now) {
		if (session.phase === 'starting') {
			db.prepare(`
				UPDATE channels
				SET phase = 'focus', ends_at = ends_at + (? * 60000)
				WHERE guild_id = ? AND channel_id = ?
			`).run(session.focus_time, guildId, channelId);
		} else if (session.phase === 'focus') {
			db.prepare(`
				UPDATE channels
				SET phase = 'break', ends_at = ends_at + (? * 60000)
				WHERE guild_id = ? AND channel_id = ?
			`).run(session.break_time, guildId, channelId);
		} else if (session.repeat_count > 0 && session.cycles >= session.repeat_count) {
			db.prepare(`
				UPDATE channels
				SET active = 0, auto_mute = 0, phase = 'stopped', ends_at = NULL
				WHERE guild_id = ? AND channel_id = ?
			`).run(guildId, channelId);
		} else {
			db.prepare(`
				UPDATE channels
				SET phase = 'focus', cycles = cycles + 1,
						ends_at = ends_at + (? * 60000)
				WHERE guild_id = ? AND channel_id = ?
			`).run(session.focus_time, guildId, channelId);
		}
		session = getChannel.get(guildId, channelId);
	}

	scheduleSession(session);
	await reconcileChannel(session);
}

async function handleVoiceStateUpdate(oldState, newState) {
	const member = newState.member || oldState.member;
	if (!member || member.user.bot) return;

	if (oldState.channelId && oldState.channelId !== newState.channelId) {
		const oldSession = getChannel.get(oldState.guild.id, oldState.channelId);
		if (oldSession) {
			await releaseMute(oldState.guild, oldState.channelId, member.id, member);
		}
	}

	if (newState.channelId) {
		for (const { channel_id: mutedChannelId } of getMemberMuteChannels.all(newState.guild.id, member.id)) {
			if (mutedChannelId !== newState.channelId) {
				await releaseMute(newState.guild, mutedChannelId, member.id, member);
			}
		}

		const session = getChannel.get(newState.guild.id, newState.channelId);
		if (session?.active && session.auto_mute && session.phase === 'focus') {
			await applyMute(newState.guild, newState.channelId, member);
		} else {
			await releaseMute(newState.guild, newState.channelId, member.id, member);
		}
	}
}

client.on('voiceStateUpdate', (oldState, newState) => {
	handleVoiceStateUpdate(oldState, newState)
		.catch((error) => console.error('Voice state handling failed:', error));
});

client.once('clientReady', async () => {
	console.log(`Pomodobot is online as ${client.user.tag}`);

	for (const { guild_id: guildId, channel_id: channelId } of db.prepare(
		'SELECT DISTINCT guild_id, channel_id FROM muted_members',
	).all()) {
		const session = getChannel.get(guildId, channelId);
		const guild = client.guilds.cache.get(guildId);
		if (!guild) continue;
		for (const { user_id: userId } of getMutedMembers.all(guildId, channelId)) {
			const member = await getGuildMember(guild, userId);
			const isStillInFocus = session?.active
				&& session.auto_mute
				&& session.phase === 'focus'
				&& member?.voice.channelId === channelId
			if (!isStillInFocus) {
				await releaseMute(guild, channelId, userId, member);
			} else if (!member.voice.serverMute) {
				forgetMutedMember.run(guildId, channelId, userId);
			}
		}
	}

	for (const session of getActiveChannels.all()) {
		await advanceSession(session.guild_id, session.channel_id);
	}
});

client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	if (!interaction.inGuild()) {
		await replyEmbed(interaction, 'Perintah tidak tersedia', 'Gunakan perintah ini di dalam server.', EMBED_COLORS.error);
		return;
	}

	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
		await replyEmbed(interaction, 'Izin diperlukan', 'Kamu memerlukan izin **Manage Channels** untuk mengatur sesi.', EMBED_COLORS.error);
		return;
	}

	const voiceChannel = interaction.member.voice?.channel;
	if (!voiceChannel?.isVoiceBased()) {
		await replyEmbed(interaction, 'Voice channel belum dipilih', 'Masuk ke voice channel yang ingin diatur terlebih dahulu.', EMBED_COLORS.error);
		return;
	}

	const { guildId } = interaction;
	const channelId = voiceChannel.id;

	if (interaction.commandName === 'start') {
		const focusTime = interaction.options.getInteger('focus_time');
		const breakTime = interaction.options.getInteger('break_time');
		const repeatInput = interaction.options.getString('repeat').trim().toLowerCase();
		let repeatCount;
		if (repeatInput === 'yes') {
			repeatCount = 0;
		} else if (repeatInput === 'no') {
			repeatCount = 1;
		} else if (/^\d+$/.test(repeatInput)) {
			repeatCount = Number(repeatInput);
			if (!Number.isSafeInteger(repeatCount) || repeatCount < 1 || repeatCount > 1000) {
				await replyEmbed(interaction, 'Nilai repeat tidak valid', 'Masukkan angka antara **1-1000**, `yes`, atau `no`.', EMBED_COLORS.error);
				return;
			}
		} else {
			await replyEmbed(interaction, 'Nilai repeat tidak valid', 'Masukkan angka antara **1-1000**, `yes`, atau `no`.', EMBED_COLORS.error);
			return;
		}
		const endsAt = Date.now() + 10_000;

		db.prepare(`
			INSERT INTO channels
				(guild_id, channel_id, focus_time, break_time, repeat_count, cycles,
				 phase, ends_at, active, auto_mute)
			VALUES (?, ?, ?, ?, ?, 1, 'starting', ?, 1, 0)
			ON CONFLICT (guild_id, channel_id) DO UPDATE SET
				focus_time = excluded.focus_time,
				break_time = excluded.break_time,
				repeat_count = excluded.repeat_count,
				cycles = 1,
				phase = 'starting',
				ends_at = excluded.ends_at,
				active = 1,
				auto_mute = 0
		`).run(guildId, channelId, focusTime, breakTime, repeatCount, endsAt);

		const session = getChannel.get(guildId, channelId);
		scheduleSession(session);
		await replyEmbed(
			interaction,
			'Pomodoro disiapkan',
			`Sesi **focus** dimulai dalam 10 detik di <#${channelId}>.`,
			EMBED_COLORS.focus,
			[
				{ name: 'Focus', value: `${focusTime} menit`, inline: true },
				{ name: 'Break', value: `${breakTime} menit`, inline: true },
				{ name: 'Pengulangan', value: repeatCount === 0 ? 'Terus-menerus' : repeatInput === 'no' ? 'Satu kali' : `${repeatCount} siklus`, inline: true },
			],
		);
		await reconcileChannel(session);
		return;
	}

	if (interaction.commandName === 'automute') {
		const session = getChannel.get(guildId, channelId);
		if (!session?.active) {
			await replyEmbed(interaction, 'Sesi belum aktif', 'Jalankan `/start` di voice channel ini sebelum mengatur automute.', EMBED_COLORS.error);
			return;
		}

		const enabled = interaction.options.getBoolean('enabled');
		db.prepare(
			'UPDATE channels SET auto_mute = ? WHERE guild_id = ? AND channel_id = ?',
		).run(enabled ? 1 : 0, guildId, channelId);

		const updated = getChannel.get(guildId, channelId);
		await replyEmbed(
			interaction,
			`Automute ${enabled ? 'aktif' : 'nonaktif'}`,
			enabled
				? `Anggota di <#${channelId}> akan otomatis di-server-mute selama sesi **focus**.`
				: `Bot tidak akan menerapkan server mute otomatis di <#${channelId}>.`,
			enabled ? EMBED_COLORS.focus : EMBED_COLORS.info,
		);
		await reconcileChannel(updated);
		return;
	}

	if (interaction.commandName === 'stop') {
		const session = getChannel.get(guildId, channelId);
		if (!session || (!session.active && !session.auto_mute)) {
			await replyEmbed(interaction, 'Tidak ada sesi aktif', 'Tidak ada pengaturan Pomodoro aktif di voice channel ini.', EMBED_COLORS.error);
			return;
		}

		clearTimer(guildId, channelId);
		db.prepare(`
			UPDATE channels
			SET active = 0, auto_mute = 0, phase = 'stopped', ends_at = NULL
			WHERE guild_id = ? AND channel_id = ?
		`).run(guildId, channelId);
		await replyEmbed(interaction, 'Sesi dihentikan', `Pomodoro dan automute di <#${channelId}> sudah dihentikan. Bot sedang melepas server mute yang diterapkannya.`, EMBED_COLORS.info);
		await releaseChannelMutes(guildId, channelId);
	}
});

client.login(process.env.DISCORD_TOKEN);
