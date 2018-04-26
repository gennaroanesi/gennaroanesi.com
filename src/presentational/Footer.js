import React from 'react';
import styled from 'styled-components';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import List, { ListItem, ListItemIcon, ListItemText } from 'material-ui/List';
import Typography from 'material-ui/Typography';
import EmailIcon from 'mdi-react/EmailIcon';
import GithubBoxIcon from 'mdi-react/GithubBoxIcon';
import FacebookIcon from 'mdi-react/FacebookIcon';
import LinkedinIcon from 'mdi-react/LinkedinIcon';
import YoutubeIcon from 'mdi-react/YoutubeIcon';
import { withStyles } from 'material-ui/styles/index';
import {
  AUTHOR_MAIL,
  AUTHOR_GITHUB,
  AUTHOR_FACEBOOK,
  AUTHOR_LINKEDIN,
  AUTHOR_YOUTUBE,
} from '../constants/contact-info';

const Container = styled(List)`
  && {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-direction: row;
    flex: 0;
    padding: 0;
    overflow: hidden;
    min-height: 40px;
    height: 40px;
  }
`;

const ListContainer = styled(List)`
  && {
    display: flex;
    align-items: flex-end;
    flex-direction: row;
    padding: 0;
    overflow: hidden;
    flex-grow: 0;
    height: 40px;
    padding-bottom: 15px;
  }
`;

const ListItemContainer = styled(ListItem)`
  && {
    margin: 0px;
    padding: 0 10px 0 10px;
  }
`;

const styles = {
  listItemIcon: {
    marginRight: '0',
  },
  whiteText: {
    color: 'rgba(255, 255, 255, 0.68)',
  },
};

class Footer extends React.PureComponent {
  render() {
    const { classes } = this.props;
    return (
      <Container>
        <ListContainer>
          <ListItemContainer
            button
            onClick={() => window.open(AUTHOR_GITHUB, '_blank')}
          >
            <ListItemText disableTypography>
              <Typography className={classNames(classes.whiteText)}>
                © 2018, Gennaro Anesi
              </Typography>
            </ListItemText>
          </ListItemContainer>
        </ListContainer>
        <ListContainer>
          <ListItemContainer
            button
            onClick={() =>
              window.open(
                `mailto:${AUTHOR_MAIL}?subject=Question&body=Hi, Gennaro!`,
              )
            }
          >
            <ListItemIcon className={classNames(classes.listItemIcon)}>
              <EmailIcon color="rgba(255,255,255,0.68" />
            </ListItemIcon>
          </ListItemContainer>
          <ListItemContainer
            button
            onClick={() => window.open(AUTHOR_LINKEDIN, '_blank')}
          >
            <ListItemIcon className={classNames(classes.listItemIcon)}>
              <LinkedinIcon color="rgba(255,255,255,0.68" />
            </ListItemIcon>
          </ListItemContainer>
          <ListItemContainer
            button
            onClick={() =>
              window.open(`${AUTHOR_GITHUB}/gennaroanesi.com`, '_blank')
            }
          >
            <ListItemIcon className={classNames(classes.listItemIcon)}>
              <GithubBoxIcon color="rgba(255,255,255,0.68" />
            </ListItemIcon>
          </ListItemContainer>
          <ListItemContainer
            button
            onClick={() => window.open(AUTHOR_FACEBOOK, '_blank')}
          >
            <ListItemIcon className={classNames(classes.listItemIcon)}>
              <FacebookIcon color="rgba(255,255,255,0.68" />
            </ListItemIcon>
          </ListItemContainer>
          <ListItemContainer
            button
            onClick={() => window.open(AUTHOR_YOUTUBE, '_blank')}
          >
            <ListItemIcon className={classNames(classes.listItemIcon)}>
              <YoutubeIcon color="rgba(255,255,255,0.68" />
            </ListItemIcon>
          </ListItemContainer>
        </ListContainer>
      </Container>
    );
  }
}

Footer.propTypes = {
  classes: PropTypes.object.isRequired,
};

export default withStyles(styles)(Footer);
