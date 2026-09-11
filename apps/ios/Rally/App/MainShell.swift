import SwiftUI

struct MainShell: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            ConversationScreen()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                .tag(AppModel.MainTab.chats)
            ProjectsScreen()
                .tabItem { Label("Projects", systemImage: "square.grid.2x2") }
                .tag(AppModel.MainTab.projects)
            NotesScreen()
                .tabItem { Label("Notes", systemImage: "note.text") }
                .tag(AppModel.MainTab.notes)
            SidekicksScreen()
                .tabItem { Label("Sidekicks", systemImage: "sparkles") }
                .tag(AppModel.MainTab.sidekicks)
        }
        .tint(colors.link)
    }
}
