import SwiftUI

struct MainShell: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            Tab("Work streams", systemImage: "bubble.left.and.bubble.right", value: AppModel.MainTab.chats) {
                ConversationScreen()
            }
            Tab("Sidekicks", systemImage: "hexagon.fill", value: AppModel.MainTab.sidekicks) {
                SidekicksScreen()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(colors.link)
    }
}
