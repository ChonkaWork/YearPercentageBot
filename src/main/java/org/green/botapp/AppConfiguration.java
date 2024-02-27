package org.green.botapp;

import lombok.RequiredArgsConstructor;
import lombok.SneakyThrows;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.telegram.telegrambots.meta.TelegramBotsApi;
import org.telegram.telegrambots.updatesreceivers.DefaultBotSession;

@Configuration
@RequiredArgsConstructor
public class AppConfiguration {
    private final TelegramProps telegramProps;

    @Bean
    @SneakyThrows
    public DailyNotificationBot dailyNotificationBot() {
        DailyNotificationBot bot = new DailyNotificationBot(telegramProps.getToken(), telegramProps.getName());
        TelegramBotsApi api = new TelegramBotsApi(DefaultBotSession.class);
        api.registerBot(bot);
        return bot;
    }
}
