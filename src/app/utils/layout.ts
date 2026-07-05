export function getInputDockShellClass(isNewConversationView: boolean): string {
  return isNewConversationView ? "px-5" : "bg-app/95 px-5 pt-2 pb-3 backdrop-blur";
}
