// Example offline scenario for obsidian_plugin_test.
//
// Copy this file into your plugin project (e.g. `dsh/scenarios/example.mjs`) and
// run: obsidian_plugin_test projectDir=… scenario=dsh/scenarios/example.mjs
//
// A scenario receives the live instance from the stub environment, so it can
// assert behaviour that the default checks do not cover — without needing a
// running Obsidian. Everything here is still the STUB, so keep assertions to
// structural facts (what got registered, what the plugin stored) rather than
// rendering or editor behaviour.

export default async function scenario({ plugin, app, stub, check, warn }) {
	// Example: a setting was persisted through saveData().
	if (Array.isArray(plugin._savedData)) {
		check("scenario: plugin saved no data during load", "warn", plugin._savedData.length === 0, "loadData/saveData were called");
	}

	// Example: a registered command can be looked up by id and has a callback.
	const commands = Object.values(app.commands.commands);
	if (commands.length === 0) {
		warn("scenario: no commands registered", "if the plugin is command-driven, this is worth investigating");
	} else {
		const missingCallback = commands.filter((c) => typeof c.callback !== "function" && typeof c.checkCallback !== "function");
		check("scenario: every command has a callback", "fail", missingCallback.length === 0, `missing on: ${missingCallback.map((c) => c.id).join(", ")}`);
	}

	// Example: a custom view type was registered and its factory produces a view.
	const viewTypes = Object.keys(app.workspace.viewFactories);
	if (viewTypes.length > 0) {
		const first = app.workspace.viewFactories[viewTypes[0]];
		let produced;
		try {
			produced = first({ view: {}, getViewType: () => viewTypes[0], containerEl: stub.__createElement("div") });
		} catch (error) {
			check("scenario: the view factory runs", "fail", false, String(error && error.message));
		}
		if (produced) check("scenario: the view factory returned a view", "fail", typeof produced.getViewType === "function");
	}
}
