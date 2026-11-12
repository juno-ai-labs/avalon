/** How a model edits a Google file that Rally may not yet be authorized to write. */
export const GoogleFileWriteAuthorizationGuidance =
  "Files with writableByRally=true can be edited immediately. If an existing file is editable by the connected user but not yet app-authorized, a requested write surfaces an Allow editing card for its one-file grant. After the user authorizes it, retry the same edit; do not create a duplicate.";
