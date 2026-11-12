// GEMS save-path conformance probe. A mod for a GameMaker patcher: `activate(api)` reads the game's
// engine family (`api.target.engine`, "gm8" or "gms") and adds one object (`api.resource.create`,
// with create and step code), which the patcher places in the first room. The object writes one
// small file per path form, one form per frame (so a form an engine chokes on cannot hide the
// others), then a report of the directory variables. Each file's content is its form id, so the
// store keys map back to forms without guessing.
//
// Run: patch the game with this mod (or add the same object to its first room by hand: its GML is
// built below); run the patched game with `drive.ts --dump store.json`; then check.ts compares the
// keys against expected.json.

const COMMON = [
  ["rel", '"p_rel.txt"'],
  ["rooted", '"\\p_rooted.txt"'],
  ["fwd", '"PSub/p_fwd.txt"'],
  ["up", '"..\\p_up.txt"'],
  ["drive", '"C:\\probe\\p_drive.txt"'],
  ["case_a", '"PCase\\P_CASE.TXT"'],
  ["case_b", '"pcase\\p_case.txt"'],
];

const GM8 = [
  ["wd", 'working_directory + "\\p_wd.txt"'],
  ["pd", 'program_directory + "\\p_pd.txt"'],
  ["tmp", 'temp_directory + "\\p_tmp.txt"'],
  ["tmp3", 'filename_dir(filename_dir(filename_dir(temp_directory))) + "\\Roaming\\probe\\p_tmp3.txt"'],
  ["env_appdata", 'environment_get_variable("APPDATA") + "\\probe\\p_env_appdata.txt"'],
  ["env_local", 'environment_get_variable("LOCALAPPDATA") + "\\probe\\p_env_local.txt"'],
  ["env_profile", 'environment_get_variable("USERPROFILE") + "\\AppData\\Local\\probe\\p_env_profile.txt"'],
];

const GMS = [
  ["wd", 'working_directory + "p_wd.txt"'],
  ["sid", 'game_save_id + "p_sid.txt"'],
  ["tmp", 'temp_directory + "p_tmp.txt"'],
  ["env_appdata", 'environment_get_variable("APPDATA") + "\\probe\\p_env_appdata.txt"'],
  ["env_local", 'environment_get_variable("LOCALAPPDATA") + "\\probe\\p_env_local.txt"'],
  ["pd", 'program_directory + "p_pd.txt"'],
];

const VARS = {
  gm8: ["working_directory", "program_directory", "temp_directory"],
  gms: ["working_directory", "program_directory", "temp_directory", "game_save_id"],
};

export default function activate(api) {
  const engine = api.target.engine;
  const forms = [...(engine === "gm8" ? GM8 : GMS), ...COMMON];
  // Each step case writes one file; the last ones are the ini, the empty directory and the report.
  const cases = forms.map(
    ([id, expr], i) =>
      `case ${i}: savepath_probe_f = file_text_open_write(${expr}); ` +
      `if (savepath_probe_f >= 0) { file_text_write_string(savepath_probe_f, "${id}"); file_text_close(savepath_probe_f); } break;`,
  );
  let n = forms.length;
  cases.push(`case ${n++}: ini_open("p_ini.ini"); ini_write_string("probe", "form", "ini"); ini_close(); break;`);
  cases.push(`case ${n++}: directory_create("p_emptydir"); break;`);
  // The report is written one variable per frame too: reading an unimplemented one can abort.
  for (const name of VARS[engine]) {
    cases.push(
      `case ${n++}: savepath_probe_f = file_text_open_write("p_var_${name}.txt"); ` +
        `if (savepath_probe_f >= 0) { file_text_write_string(savepath_probe_f, ${name}); file_text_close(savepath_probe_f); } break;`,
    );
  }
  api.resource.create({
    kind: "object",
    name: "savepath_probe",
    events: {
      create: "savepath_probe_n = 0; savepath_probe_f = -1;",
      // Counted before the switch, so a case that aborts the event still moves the probe on.
      step: `savepath_probe_n += 1; switch (savepath_probe_n - 1) { ${cases.join(" ")} }`,
    },
  });
}
