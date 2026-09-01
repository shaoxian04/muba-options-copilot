/**
 * `/insights` renders the exact same surface as `/` -- there is no separate Insights
 * page or component tree. This file exists only so a direct hit (a bookmark, a
 * refresh, someone pasting the URL) lands somewhere real instead of a 404; `Chat`
 * reads the current path itself to decide which tab starts selected. Switching tabs
 * while already on the page never goes through this file at all -- see `Chat.tsx`.
 */
export { default } from "../page";
