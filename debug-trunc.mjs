import { register } from "node:module";
register("./tools/smoke-hooks.mjs", import.meta.url);
const mod = await import("./extensions/vision-proxy.ts");
const resolvers = [];
mod.default({
	on: () => () => {},
	registerCommand: () => {},
	registerTool: () => {},
	registerToolRenderer: (r) => resolvers.push(r),
});
const analyze = resolvers[0]("analyze_image", () => undefined);
const theme = { fg: (t, x) => x, bold: (x) => x };
const comp = analyze.renderCall(
	{
		images: [`image="${"deadbeef".repeat(4)}"`, "C:\\Users\\u\\shot.png"],
		question: "What does the legend say?",
		crop: [{ image_index: 0, region: "bottom-right" }],
	},
	theme,
	{},
);
const lines = comp.render(80);
console.log(JSON.stringify(lines, null, 1));
const plain = lines.join("\n");
console.log("plain len:", plain.length);
console.log("has deadbeef:", plain.includes('image="deadbeef…"'));
