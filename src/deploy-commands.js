require('dotenv').config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
	throw new Error('DISCORD_TOKEN and CLIENT_ID are required in the environment.');
}

const commands = [
	new SlashCommandBuilder()
		.setName('start')
		.setDescription('Mulai Pomodoro untuk voice channel tempat kamu berada.')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
		.addIntegerOption((option) => option
			.setName('focus_time')
			.setDescription('Durasi fokus dalam menit.')
			.setMinValue(1)
			.setMaxValue(1440)
			.setRequired(true))
		.addIntegerOption((option) => option
			.setName('break_time')
			.setDescription('Durasi istirahat dalam menit.')
			.setMinValue(1)
			.setMaxValue(1440)
			.setRequired(true))
		.addStringOption((option) => option
			.setName('repeat')
			.setDescription('Isi yes untuk terus-menerus, no untuk sekali, atau jumlah siklus 1-1000.')
			.setRequired(true)),
	new SlashCommandBuilder()
		.setName('automute')
		.setDescription('Atur server mute otomatis pada fase fokus di voice channel ini.')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
		.addBooleanOption((option) => option
			.setName('enabled')
			.setDescription('Pilih yes untuk mengaktifkan atau no untuk menonaktifkan.')
			.setRequired(true)),
	new SlashCommandBuilder()
		.setName('stop')
		.setDescription('Hentikan Pomodoro dan automute di voice channel ini.')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = GUILD_ID
	? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
	: Routes.applicationCommands(CLIENT_ID);

rest.put(route, { body: commands })
	.then(() => console.log(`Registered ${commands.length} slash commands${GUILD_ID ? ` in guild ${GUILD_ID}` : ' globally'}.`))
	.catch((error) => {
		console.error('Failed to register slash commands:', error);
		process.exitCode = 1;
	});
