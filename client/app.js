/* ==========================================================================
   GEARWORKS CLIENT — rendering, input, UI, audio, and the game controller
   --------------------------------------------------------------------------
   All game STATE lives in the shared core (window.Core). This file never
   mutates it directly: every player action becomes a command submitted
   through the active session (LocalSession for singleplayer, NetSession
   for multiplayer). Predicted "ghosts" cover the command round-trip so
   building feels instant even at 100+ ms latency; the core's 'applied'
   events clear ghosts and feed the per-player undo/redo stacks.
   ========================================================================== */
'use strict';

var Config = Core.Config, Util = Core.Util;   // convenience aliases
var G = null;      // active core game instance
var Sess = null;   // active session driver
