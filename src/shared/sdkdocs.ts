// Reference for the realtime SDK (src/sdk/gapp.ts), shown to the agent in its
// prompt and to the user on the Catalog page.

export const sdkReference = `import { connect } from "/sdk/gapp.js";   // in custom components
import { connect } from "./gapp";          // in a custom backend (server.ts)
const gapp = connect();                    // url and app id are filled in automatically

await gapp.query(table, { where?, sort?: { column, dir? }, limit? })   // rows, newest first by default
await gapp.aggregate(table, { aggregate, column?, where?, groupBy?, bucket?, seriesBy? })  // number or groups
await gapp.insert(table, values | values[])     // returns the number inserted
await gapp.update(table, where, values)         // returns the number changed
await gapp.delete(table, where)                 // {} deletes all rows
const stop = gapp.live(table, { where?, sort?, limit? }, (rows) => render(rows))  // now + after every change, from anywhere
gapp.onChange((tables) => …)                    // after any write to this app
const room = gapp.channel("name")               // ephemeral messages between everything open (not stored)
room.send(data); room.on((data) => …)
await gapp.backend.fetch("/path", init?)        // the app's custom backend (custom components only need this)
await gapp.backend.json("/path")                // GET + parse JSON`;

export const customCssReference = `CSS variables (follow the user's theme): --gapp-bg --gapp-surface --gapp-surface-hover --gapp-text --gapp-muted --gapp-border --gapp-accent --gapp-accent-text --gapp-accent-soft --gapp-danger --gapp-success --gapp-warning --gapp-radius --gapp-radius-sm --gapp-font --gapp-mono
Base styles already make buttons, inputs, selects and textareas look native; helpers: button.primary, .card, .row, .stack, .muted. The page background is transparent.`;
