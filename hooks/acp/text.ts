// What a harness names reaches the screen without characters that could disguise it: control
// characters (escape sequences), and bidirectional, zero-width, variation and tag characters. Line
// breaks are kept; each caller decides how to show them.
export const unhidden = (text: string) =>
  text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu,
    '',
  )
